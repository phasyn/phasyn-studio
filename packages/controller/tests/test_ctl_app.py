"""App 層：跨站寫入防呆、SPA、主控資訊、pipeline／preset、轉送、未預期錯誤、設定與鎖、CLI client。"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any

import pytest
from controller_support import CONTROLLER_HOST, Harness
from phasyn_components import contracts
from phasyn_components.settings import normalize_recording
from phasyn_controller import run
from phasyn_controller.static import FRAME_HEADERS, IMMUTABLE, NO_CACHE
from phasyn_server import DataDirBusy, DataDirLock

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def test_cross_site_write_guard_and_no_cors(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            preset = {"preset_id": "p", "label": "x", "provider_id": "test.echo", "settings": "bad"}
            for origin, status in (("http://evil.example", 400), ("null", 400), (CONTROLLER_HOST, 422), (None, 422)):
                headers = {"Origin": origin} if origin else {}
                resp = await h.client.put("/api/presets/p", json=preset, headers=headers)
                assert resp.status_code == status, origin
                assert "access-control-allow-origin" not in resp.headers
                if status == 400:
                    assert resp.json() == {
                        "code": "BAD_REQUEST",
                        "message": "跨站寫入請求被拒絕",
                        "details": resp.json()["details"],
                    }
            resp = await h.client.get("/api/presets", headers={"Origin": "http://evil.example"})
            assert resp.status_code == 200  # 只擋寫入；這不是身份驗證
            assert (await h.client.options("/api/presets")).status_code == 405

    asyncio.run(scenario())


def test_static_spa_and_missing_static_dir(tmp_path: Path) -> None:
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    inline = "document.documentElement.lang = 'en';"
    page = f'<html><script>{inline}</script><script type="module" src="/assets/app.js"></script>spa</html>'
    (static / "index.html").write_text(page, encoding="utf-8")
    (static / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    inline_hash = "'sha256-" + base64.b64encode(hashlib.sha256(inline.encode()).digest()).decode() + "'"

    async def scenario() -> None:
        async with Harness(tmp_path / "a", static_dir=str(static)) as h:
            index = await h.client.get("/")
            assert index.text == page
            deep = await h.client.get("/recordings/abc")
            assert deep.status_code == 200 and deep.text == page  # 前端路由 fallback
            asset = await h.client.get("/assets/app.js")
            assert asset.text == "console.log(1)"
            for response in (index, deep, asset):  # no other site may frame the UI (clickjacking)
                assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
                assert response.headers["x-frame-options"] == "DENY"
            assert asset.headers["content-security-policy"] == "frame-ancestors 'none'"
            # The page runs its own inline script and scripts of this origin, nothing else, and calls nowhere else.
            policy = dict(part.split(" ", 1) for part in index.headers["content-security-policy"].split("; "))
            assert policy["script-src"] == f"'self' {inline_hash}" and policy["default-src"] == "'self'"
            assert policy["object-src"] == "'none'" and policy["base-uri"] == "'none'"
            assert policy["connect-src"] == "'self'" and "unsafe-eval" not in index.headers["content-security-policy"]
            assert deep.headers["content-security-policy"] == index.headers["content-security-policy"]
            # A rebuilt page (served without a restart) gets the policy of its own inline scripts.
            rebuilt = page.replace("'en'", "'ja'")
            (static / "index.html").write_text(rebuilt, encoding="utf-8")
            os.utime(static / "index.html", ns=(1, 1))
            again = await h.client.get("/")
            assert again.text == rebuilt and inline_hash not in again.headers["content-security-policy"]
            api = await h.client.get("/api/does-not-exist")
            assert api.status_code == 404 and api.json()["code"] == "NOT_FOUND"
        async with Harness(tmp_path / "b", static_dir=str(tmp_path / "missing")) as h:
            root = await h.client.get("/")
            assert root.status_code == 200 and "前端靜態檔" in root.text
            assert {k.lower(): v for k, v in FRAME_HEADERS.items()}.items() <= dict(root.headers).items()
            info = (await h.client.get("/api/controller")).json()
            contracts.validate("ControllerInfo", info)  # API 照常
            assert info["controller_id"] == h.config.instance_id and info["max_active_runs"] == 1

    asyncio.run(scenario())


def test_static_gzip_and_cache_headers(tmp_path: Path) -> None:
    """Precompressed siblings are sent to gzip clients; hashed assets are immutable, index.html is no-cache."""
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html>spa</html>", encoding="utf-8")
    source = "console.log('phasyn');" * 50
    (static / "assets" / "app-1a2b3c.js").write_text(source, encoding="utf-8")
    (static / "assets" / "app-1a2b3c.js.gz").write_bytes(gzip.compress(source.encode("utf-8")))
    (static / "assets" / "plain-4d5e6f.css").write_text("body{}", encoding="utf-8")
    (static / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    (static / "assets" / "leak.js").write_text("x", encoding="utf-8")
    (static / "assets" / "leak.js.gz").symlink_to(tmp_path / "secret.txt")  # a sibling outside the root

    async def scenario() -> None:
        async with Harness(tmp_path / "ctl", static_dir=str(static)) as h:
            packed = await h.client.get("/assets/app-1a2b3c.js", headers={"Accept-Encoding": "gzip"})
            assert packed.status_code == 200 and packed.text == source  # httpx decodes the gzip body
            assert packed.headers["content-encoding"] == "gzip" and packed.headers["vary"] == "Accept-Encoding"
            assert packed.headers["cache-control"] == IMMUTABLE
            assert packed.headers["content-type"].startswith(("text/javascript", "application/javascript"))
            raw = await h.client.get("/assets/app-1a2b3c.js", headers={"Accept-Encoding": "identity"})
            assert raw.text == source and "content-encoding" not in raw.headers
            assert raw.headers["vary"] == "Accept-Encoding" and raw.headers["cache-control"] == IMMUTABLE
            plain = await h.client.get("/assets/plain-4d5e6f.css", headers={"Accept-Encoding": "gzip"})
            assert plain.text == "body{}" and "content-encoding" not in plain.headers and "vary" not in plain.headers
            assert (await h.client.get("/favicon.svg")).headers["cache-control"] == NO_CACHE  # not content-hashed
            for route in ("/", "/index.html", "/studio/projects/x"):
                page = await h.client.get(route)
                assert page.text == "<html>spa</html>" and page.headers["cache-control"] == NO_CACHE
            leak = await h.client.get("/assets/leak.js", headers={"Accept-Encoding": "gzip"})
            assert leak.text == "x" and "content-encoding" not in leak.headers
            escaped = await h.client.get("/assets/..%2F..%2Fsecret.txt")
            assert escaped.text == "<html>spa</html>"

    asyncio.run(scenario())


def test_preset_delete(tmp_path: Path) -> None:
    """D-23: DELETE /api/presets/{preset_id} removes the saved preset only (404 when it does not exist)."""
    preset = {
        "preset_id": "fast",
        "label": "快速",
        "provider_id": "test.echo",
        "settings": {
            "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": "g"}},
            "invoke": {"steps": 2},
            "recording": normalize_recording({"mode": "summary"}),
        },
    }
    delete_op = json.loads((CONTRACTS / "openapi.json").read_text(encoding="utf-8"))["paths"][
        "/api/presets/{preset_id}"
    ]["delete"]
    deleted_schema = delete_op["responses"]["200"]["content"]["application/json"]["schema"]

    async def scenario() -> None:
        async with Harness(tmp_path) as h:
            assert (await h.client.put("/api/presets/fast", json=preset)).status_code == 200
            stored = h.config.data_dir / "config" / "presets" / "fast.json"
            assert stored.is_file()
            resp = await h.client.delete("/api/presets/fast")
            assert resp.status_code == 200 and resp.json() == {"preset_id": "fast", "deleted": True}
            contracts.validate_with_schema(deleted_schema, resp.json(), code="RUNTIME_ERROR", what="DELETE preset 回應")
            assert not stored.exists() and (await h.client.get("/api/presets")).json() == {"items": []}
            again = await h.client.delete("/api/presets/fast")
            assert again.status_code == 404 and again.json()["code"] == "NOT_FOUND"
            contracts.validate("Error", again.json())
            bad = await h.client.delete("/api/presets/..%2Fcontroller")
            assert bad.status_code in (404, 422)
            cross_site = await h.client.delete("/api/presets/fast", headers={"Origin": "http://evil.example"})
            assert cross_site.status_code == 400 and cross_site.json()["code"] == "BAD_REQUEST"

    asyncio.run(scenario())


def test_unexpected_error_is_500_without_stack(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path) as h:

            def boom(*args: Any, **kwargs: Any) -> Any:
                raise RuntimeError("secret detail")

            h.ctl.store.list = boom  # type: ignore[method-assign]
            resp = await h.client.get("/api/recordings")
            assert resp.status_code == 500
            body = resp.json()
            contracts.validate("Error", body)
            assert body["code"] == "RUNTIME_ERROR" and body["details"] == {"exception_type": "builtins.RuntimeError"}
            assert "secret detail" not in resp.text and "Traceback" not in resp.text

    asyncio.run(scenario())


def test_data_dir_lock_and_run_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data = tmp_path / "data"
    config_path = tmp_path / "controller.json"
    config_path.write_text(
        json.dumps(
            {
                "instance_id": str(uuid.uuid4()),
                "data_dir": str(data),
                "advertise_url": "http://127.0.0.1:18080",
                "port": 18080,
            }
        ),
        encoding="utf-8",
    )
    first = DataDirLock(data)
    first.acquire()
    try:
        with pytest.raises(DataDirBusy, match="已被另一個程序使用"):
            DataDirLock(data).acquire()
        assert run(str(config_path)) == 2  # 第二個程序：明確訊息後退出碼 2
        assert "已被另一個程序使用" in capsys.readouterr().err

        async def second_app() -> None:
            h = Harness(data)
            with pytest.raises(DataDirBusy):
                await h.ctl.startup()
            await h.client.aclose()

        asyncio.run(second_app())
    finally:
        first.release()
    assert run(str(tmp_path / "missing.json")) == 1
    assert "無法讀取主控設定檔" in capsys.readouterr().err
