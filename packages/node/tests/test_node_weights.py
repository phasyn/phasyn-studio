"""Model weight downloads on the Node.

The source is an in-memory Hugging Face (httpx.MockTransport: resolve URLs, Range, redirects to a CDN host, errors);
no real network is used. The download manager runs against small fakes of the Node service and of one component
instance; the last test goes through the real Node app (runtime ``--weights`` subprocess and the HTTP routes).

- missing files are downloaded into the component's model root and verified (SHA-256 or git blob SHA-1); the job
  reports actual bytes, clears the describe cache and the stale "not configured" error;
- a partial file resumes with a Range request (and starts over when the source ignores it); a wrong hash deletes the
  partial file, a short body keeps it; nothing is retried;
- identical files already on disk are hard-linked after their hash is checked; a same-size file with other content is
  not linked;
- files of another size are replaced only when asked; a too-small disk, a running job, a busy component and a missing
  license acknowledgement are refused before anything is written;
- the token goes to the source host only, never to the CDN it redirects to, and never back through the API.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
from node_testkit import assert_valid
from phasyn_components.errors import ComponentError
from phasyn_components.weights import WeightFile, WeightLicense, WeightPlan, WeightSet
from phasyn_node import weights as weights_module
from phasyn_node.weights import WeightsManager, part_path, plan_targets

pytestmark = pytest.mark.anyio

REPO = "org/model"
REV = "0123456789abcdef0123456789abcdef01234567"
ENDPOINT = "https://hub.test"
BIG = bytes(range(256)) * 40  # 10 KiB, verified with SHA-256
SMALL = b'{"model_type": "fake"}\n'  # verified with the git blob id
SHARED = b"shared weights " * 300


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_oid(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\x00" % len(data) + data, usedforsecurity=False).hexdigest()


def weight_set(
    files: dict[str, bytes],
    *,
    set_id: str = "fake-model",
    dest: str = "fake",
    links: dict[str, tuple[str, ...]] | None = None,
) -> WeightSet:
    items = tuple(
        WeightFile(path=path, size=len(data), sha256=sha256(data))
        if len(data) > 1000
        else WeightFile(path=path, size=len(data), git_oid=git_oid(data))
        for path, data in files.items()
    )
    return WeightSet(
        set_id=set_id,
        label="Fake model",
        repo=REPO,
        revision=REV,
        license=WeightLicense(name="Test License", url="https://example.test/license"),
        dest=dest,
        files=items,
        links=links or {},
    )


class Hub:
    """resolve/{revision}/{path} for REPO; optional redirect to a CDN host, ignored ranges, short bodies or a status."""

    def __init__(
        self,
        files: dict[str, bytes],
        *,
        redirect: bool = False,
        ignore_range: bool = False,
        short: bool = False,
        status: int | None = None,
    ) -> None:
        self.files = files
        self.redirect = redirect
        self.ignore_range = ignore_range
        self.short = short
        self.status = status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        prefix = f"/{REPO}/resolve/{REV}/"
        if request.url.host == "hub.test" and self.redirect:
            return httpx.Response(302, headers={"Location": f"https://cdn.test{request.url.path}"})
        if self.status is not None:
            return httpx.Response(self.status, text="nope")
        path = request.url.path
        assert path.startswith(prefix), path
        data = self.files.get(path[len(prefix) :])
        if data is None:
            return httpx.Response(404)
        if self.short:
            return httpx.Response(200, content=data[: len(data) // 2])
        ranged = request.headers.get("range")
        if ranged and not self.ignore_range:
            start = int(ranged.removeprefix("bytes=").removesuffix("-"))
            if start >= len(data):
                return httpx.Response(416)
            return httpx.Response(
                206, content=data[start:], headers={"Content-Range": f"bytes {start}-{len(data) - 1}/{len(data)}"}
            )
        return httpx.Response(200, content=data)

    def paths(self) -> list[str]:
        return [request.url.path.rsplit("/", 1)[-1] for request in self.requests if request.url.host == "hub.test"]


class Commands:
    def __init__(self, plan: WeightPlan) -> None:
        self.plan = plan
        self.forgot = 0

    async def weights(self, runtime: Any, provider_id: str, settings: Any) -> dict[str, Any]:
        return self.plan.to_dict()

    def forget_unavailable(self) -> None:
        self.forgot += 1


class Service:
    def __init__(self, plan: WeightPlan) -> None:
        self.commands = Commands(plan)
        self.shutting_down = False
        self.changes = 0
        self.tasks: set[asyncio.Task[Any]] = set()
        self.instances: dict[str, Any] = {}

    def spawn_task(self, coro: Any, *, name: str) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro, name=name)
        self.tasks.add(task)
        return task

    def notify_change(self) -> None:
        self.changes += 1


class Settings:
    def __init__(self, root: Path) -> None:
        self.root = root

    def snapshot(self) -> tuple[dict[str, Any], int]:
        return {"load": {"model_path": str(self.root)}}, 1


class Instance:
    component_id = "dit"
    provider_id = "fake.dit"

    def __init__(self, root: Path, state: str = "stopped") -> None:
        self.settings = Settings(root)
        self.state = state
        self.cleared = 0

    def runtime_entry(self) -> object:
        return object()

    def forget_configuration_error(self) -> None:
        self.cleared += 1


def manager(
    tmp_path: Path, plan: WeightPlan, hub: Hub, *, token: str | None = None
) -> tuple[WeightsManager, Service, Instance]:
    service = Service(plan)
    env = {"HF_ENDPOINT": ENDPOINT, **({"HF_TOKEN": token} if token else {})}
    mgr = WeightsManager(service, roots=[tmp_path], transport=httpx.MockTransport(hub.handler), env=env)  # type: ignore[arg-type]
    inst = Instance(tmp_path / "models")
    service.instances[inst.component_id] = inst
    return mgr, service, inst


async def finished(mgr: WeightsManager, inst: Instance) -> dict[str, Any]:
    job = mgr._jobs[inst.component_id]
    assert job.task is not None
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(asyncio.shield(job.task), timeout=10)
    return job.to_dict()


async def download(mgr: WeightsManager, inst: Instance, **body: Any) -> dict[str, Any]:
    started = await mgr.start(inst, {"accept_licenses": True, **body})  # type: ignore[arg-type]
    assert_valid("WeightsDownloadJob", started)
    return await finished(mgr, inst)


async def test_a_wrong_hash_deletes_the_partial_file_and_fails_without_retrying(tmp_path: Path) -> None:
    good = {"model.safetensors": BIG}
    plan = WeightPlan(root=str(tmp_path / "models"), sets=(weight_set(good),))
    hub = Hub({"model.safetensors": bytes(reversed(BIG))})
    mgr, service, inst = manager(tmp_path, plan, hub)

    job = await download(mgr, inst)
    assert job["state"] == "failed"
    assert job["error"]["code"] == "FILE_HASH_MISMATCH"
    target = tmp_path / "models" / "fake" / "model.safetensors"
    assert not target.exists() and not part_path(target).exists()
    assert len(hub.requests) == 1
    assert service.commands.forgot == 0 and inst.cleared == 0


async def test_the_token_goes_to_the_source_host_only(tmp_path: Path) -> None:
    files = {"config.json": SMALL}
    plan = WeightPlan(root=str(tmp_path / "models"), sets=(weight_set(files),))
    hub = Hub(files, redirect=True)
    mgr, _service, inst = manager(tmp_path, plan, hub, token="hf_secret")

    view = await mgr.view(inst)  # type: ignore[arg-type]
    assert view["source"] == {"endpoint": ENDPOINT, "token": True}
    assert "hf_secret" not in repr(view)
    job = await download(mgr, inst)
    assert job["state"] == "succeeded", job["error"]
    by_host = {request.url.host: request.headers.get("authorization") for request in hub.requests}
    assert by_host == {"hub.test": "Bearer hf_secret", "cdn.test": None}


async def test_a_same_size_file_with_other_content_is_downloaded_not_linked(tmp_path: Path) -> None:
    files = {"B/shared.bin": SHARED}
    plan = WeightPlan(
        root=str(tmp_path / "models"),
        sets=(weight_set(files, dest="repo", links={"B/shared.bin": ("repo/A/shared.bin",)}),),
    )
    hub = Hub(files)
    mgr, _service, inst = manager(tmp_path, plan, hub)
    twin = tmp_path / "models" / "repo" / "A" / "shared.bin"
    twin.parent.mkdir(parents=True)
    twin.write_bytes(bytes(len(SHARED)))

    job = await download(mgr, inst)
    assert job["state"] == "succeeded", job["error"]
    assert job["files_linked"] == 0
    assert job["bytes_done"] == job["bytes_total"] == len(SHARED)
    linked = tmp_path / "models" / "repo" / "B" / "shared.bin"
    assert linked.read_bytes() == SHARED and os.stat(linked).st_ino != os.stat(twin).st_ino


async def test_files_of_another_size_are_replaced_only_when_asked(tmp_path: Path) -> None:
    files = {"config.json": SMALL}
    plan = WeightPlan(root=str(tmp_path / "models"), sets=(weight_set(files),))
    mgr, _service, inst = manager(tmp_path, plan, Hub(files))
    target = tmp_path / "models" / "fake" / "config.json"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"{}")
    assert (await mgr.view(inst))["sets"][0]["files_mismatch"] == 1  # type: ignore[arg-type]

    with pytest.raises(ComponentError) as refused:
        await mgr.start(inst, {"accept_licenses": True})  # type: ignore[arg-type]
    assert refused.value.code == "WEIGHTS_DESTINATION_CONFLICT"
    assert refused.value.details["files"] == ["fake/config.json"]
    assert target.read_bytes() == b"{}"

    job = await download(mgr, inst, replace_mismatched=True)
    assert job["state"] == "succeeded", job["error"]
    assert target.read_bytes() == SMALL


async def test_refusals_before_anything_is_written(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    files = {"model.safetensors": BIG}
    plan = WeightPlan(root=str(tmp_path / "models"), sets=(weight_set(files),))
    mgr, _service, inst = manager(tmp_path, plan, Hub(files))

    with pytest.raises(ComponentError) as no_license:
        await mgr.start(inst, {"accept_licenses": False})  # type: ignore[arg-type]
    assert no_license.value.code == "INVALID_ARGUMENT"

    with pytest.raises(ComponentError) as unknown:
        await mgr.start(inst, {"accept_licenses": True, "sets": ["other"]})  # type: ignore[arg-type]
    assert unknown.value.code == "INVALID_ARGUMENT"

    busy = Instance(tmp_path / "models", state="ready")
    with pytest.raises(ComponentError) as not_stopped:
        await mgr.start(busy, {"accept_licenses": True})  # type: ignore[arg-type]
    assert not_stopped.value.code == "STATE_CONFLICT"

    monkeypatch.setattr(weights_module, "free_bytes", lambda _root: 1024)
    with pytest.raises(ComponentError) as full:
        await mgr.start(inst, {"accept_licenses": True})  # type: ignore[arg-type]
    assert full.value.code == "DISK_FULL"
    assert full.value.details["needed_bytes"] == len(BIG)
    assert not (tmp_path / "models").exists()


async def test_one_download_per_node_and_cancel_keeps_the_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(weights_module, "CHUNK_BYTES", 1000)  # hand the first 3000 bytes over before the stream stalls
    files = {"model.safetensors": BIG}
    plan = WeightPlan(root=str(tmp_path / "models"), sets=(weight_set(files),))
    gate = asyncio.Event()

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[override]
            yield BIG[:3000]
            await gate.wait()
            yield BIG[3000:]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=SlowStream())

    service = Service(plan)
    mgr = WeightsManager(
        service,  # type: ignore[arg-type]
        roots=[tmp_path],
        transport=httpx.MockTransport(handler),
        env={"HF_ENDPOINT": ENDPOINT},
    )
    inst = Instance(tmp_path / "models")
    started = await mgr.start(inst, {"accept_licenses": True})  # type: ignore[arg-type]
    target = tmp_path / "models" / "fake" / "model.safetensors"
    for _ in range(500):
        if mgr._jobs[inst.component_id].bytes_done == 3000:
            break
        await asyncio.sleep(0.01)
    assert mgr._jobs[inst.component_id].bytes_done == 3000
    other = Instance(tmp_path / "other")
    other.component_id = "te"
    with pytest.raises(ComponentError) as second:
        await mgr.start(other, {"accept_licenses": True})  # type: ignore[arg-type]
    assert second.value.code == "STATE_CONFLICT"
    assert second.value.details["job_id"] == started["job_id"]

    cancelled = await mgr.cancel(inst)  # type: ignore[arg-type]
    assert cancelled["state"] == "cancelled"
    assert part_path(target).read_bytes() == BIG[:3000]
    assert not target.exists()
    gate.set()


async def test_weights_go_only_into_the_configured_model_directories(tmp_path: Path) -> None:
    """``load.model_path`` can be changed through the API, the Node configuration cannot: a root outside the
    configured model directories is neither inspected nor written to, also when a link leads out of them."""
    files = {"config.json": SMALL}
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "fake").mkdir()
    (outside / "fake" / "config.json").write_bytes(b"x")  # another size: replace_mismatched would overwrite it
    allowed = tmp_path / "models"
    allowed.mkdir()
    (allowed / "escape").symlink_to(outside, target_is_directory=True)
    hub = Hub(files)
    env = {"HF_ENDPOINT": "https://user:mirror-secret@hub.test"}
    for root in (outside, allowed / "escape", tmp_path):
        service = Service(WeightPlan(root=str(root), sets=(weight_set(files),)))
        mgr = WeightsManager(service, roots=[allowed], transport=httpx.MockTransport(hub.handler), env=env)  # type: ignore[arg-type]
        inst = Instance(root)
        view = await mgr.view(inst)  # type: ignore[arg-type]
        assert_valid("WeightsView", view)
        assert (view["root"], view["sets"], view["free_bytes"]) == (None, [], None), root
        assert view["notes"][0] == weights_module.ROOT_NOT_ALLOWED_REASON
        assert view["source"]["endpoint"] == "https://hub.test" and "mirror-secret" not in repr(view)
        with pytest.raises(ComponentError) as refused:
            await mgr.start(inst, {"accept_licenses": True, "replace_mismatched": True})  # type: ignore[arg-type]
        assert refused.value.code == "COMPONENT_NOT_CONFIGURED"
    assert hub.requests == [] and (outside / "fake" / "config.json").read_bytes() == b"x"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["elsewhere", "models"]

    inside = Service(WeightPlan(root=str(allowed / "sub"), sets=(weight_set(files),)))
    mgr = WeightsManager(inside, roots=[allowed], transport=httpx.MockTransport(hub.handler), env=env)  # type: ignore[arg-type]
    job = await download(mgr, Instance(allowed / "sub"))
    assert job["state"] == "succeeded", job["error"]
    assert (allowed / "sub" / "fake" / "config.json").read_bytes() == SMALL


def test_targets_share_one_location_once_and_refuse_two_different_files() -> None:
    license_file = {"LICENSE": b"license text\n"}
    first = weight_set({**license_file, "A/x.json": SMALL}, set_id="a", dest="repo")
    second = weight_set({**license_file, "B/x.json": SMALL}, set_id="b", dest="repo")
    targets = plan_targets(WeightPlan(root="/m", sets=(first, second)))
    assert [target.rel for target in targets] == ["repo/LICENSE", "repo/A/x.json", "repo/B/x.json"]

    clash = weight_set({"LICENSE": b"other text\n"}, set_id="c", dest="repo")
    with pytest.raises(ComponentError):
        plan_targets(WeightPlan(root="/m", sets=(first, clash)))
