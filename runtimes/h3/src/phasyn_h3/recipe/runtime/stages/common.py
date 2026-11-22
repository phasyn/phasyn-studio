"""Shared stage plumbing: input resolution, progress, cancel, outputs, identity."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypedDict, Unpack

from phasyn_h3.recipe.abi import media_types
from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.errors import diagnostic
from phasyn_h3.recipe.abi.stage import OutputFile, StageContext, StageInput, StageResult
from phasyn_h3.recipe.abi.timeutil import now_rfc3339
from phasyn_h3.recipe.abi.values import parse_seed

from .. import FAMILY, PROVIDER_ID, PROVIDER_VERSION, SGLANG_SOURCE_REVISION
from .._arguments import validate_keywords
from ..bundles import BundleIdentity
from ..errors import InvalidStageInput
from ..measure import COST_STAGES, AnalyticFlop
from ..policy import StagePolicy


class _LoopProgress(TypedDict, total=False):
    completed_updates: int | None
    planned_updates: int | None
    actual_dit_evaluations: int | None


if TYPE_CHECKING:  # pragma: no cover
    from ..provider import SGLangH3Provider

# logical role -> (upstream output names, upstream stage ids / input names)
_ROLE_ALIASES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "prepared": (("prepared",), ("prepare_media",)),
    "conditioning": (("conditioning",), ("encode_conditioning",)),
    "references": (("references",), ("encode_references",)),
    "adaln": (("adaln",), ("prepare_adaln",)),
    "residency": (("residency",), ("load_dit",)),
    "packed": (("packed",), ("assemble_inputs",)),
    "target_latents": (("target_latents",), ("denoise_av",)),
    "init_latents": (("init_latents",), ()),
    "nag_conditioning": (("nag_conditioning",), ()),
}
_MATERIAL_RE = re.compile(r"^material_(\d+)$")


@dataclass(frozen=True)
class ResolvedInput:
    """A stage input whose file was checked to exist (``StageInput`` with a non-optional path)."""

    name: str
    path: Path
    artifact: Mapping[str, Any] | None


PINNED_SGLANG_MAX_SEED = 2**63 - 1


@dataclass
class StageRun:
    """Expose the current stage, its inputs and its outputs."""

    provider: SGLangH3Provider
    stage: Mapping[str, Any]
    ctx: StageContext
    policy: StagePolicy
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    outputs: list[OutputFile] = field(default_factory=list)
    # compute timing / analytic FLOPs of this stage (``measure``), reported by the provider
    measurements: dict[str, Any] = field(default_factory=dict)

    # -- identity ------------------------------------------------------------
    @property
    def kind(self) -> str:
        """Return the native stage kind."""
        return str(self.stage["kind"])

    @property
    def stage_id(self) -> str:
        """Return the identifier of the executing stage."""
        return str(
            self.stage.get("stage_id")
            or self.ctx.assignment.get("stage_id")
            or self.kind
        )

    @property
    def plan(self) -> Mapping[str, Any]:
        """Return the frozen stage plan."""
        return self.ctx.plan

    @property
    def geometry(self) -> Mapping[str, Any]:
        """Return the audio and video geometry for this job."""
        return self.ctx.plan.get("geometry") or {}

    @property
    def output_dir(self) -> Path:
        """Return the output directory owned by this stage."""
        self.ctx.output_dir.mkdir(parents=True, exist_ok=True)
        return self.ctx.output_dir

    def plan_digest(self) -> str:
        """Identify the resolved plan used by this stage."""
        digest = self.ctx.assignment.get("plan_digest")
        return str(digest) if digest else canonical_digest(dict(self.ctx.plan))

    def bundle_identity(self, normalization_config_digest: str) -> BundleIdentity:
        """Build the identity used when publishing this stage bundle."""
        model_digest = self.ctx.plan.get("model_digest") or canonical_digest(
            dict(self.ctx.plan.get("model") or {})
        )
        return BundleIdentity(
            model_digest=str(model_digest),
            adapter_digest=adapter_digest(),
            plan_digest=self.plan_digest(),
            stage_id=self.stage_id,
            normalization_config_digest=normalization_config_digest,
        )

    # -- inputs ----------------------------------------------------------------
    def _spec_inputs(self) -> list[Mapping[str, Any]]:
        return list(self.stage.get("inputs") or [])

    def find_input(self, role: str) -> StageInput | None:
        """Return the matching stage input when present."""
        outputs, names = _ROLE_ALIASES[role]
        for spec in self._spec_inputs():
            if (
                spec.get("upstream_output_name") in outputs
                or spec.get("name") in names
                or spec.get("name") == role
            ):
                item = self.ctx.inputs.get(str(spec["name"]))
                if item is not None:
                    return item
        for name in (*names, role):
            if name in self.ctx.inputs:
                return self.ctx.inputs[name]
        return None

    def require_input(self, role: str) -> ResolvedInput:
        """Return the required input or fail the stage."""
        item = self.find_input(role)
        if item is None or item.path is None:
            raise InvalidStageInput(
                "STAGE_INPUT_MISSING", f"{self.kind} 缺少必要輸入 {role}"
            )
        if not Path(item.path).is_file():
            raise InvalidStageInput(
                "STAGE_INPUT_FILE_MISSING",
                f"{self.kind} 輸入 {role} 檔案不存在：{item.path}",
            )
        return ResolvedInput(item.name, Path(item.path), item.artifact)

    def read_json_input(
        self, role: str, *, required: bool = True
    ) -> dict[str, Any] | None:
        """Read the structured data of a named stage input."""
        item = self.require_input(role) if required else self.find_input(role)
        if item is None or item.path is None:
            return None
        try:
            doc = json.loads(Path(item.path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise InvalidStageInput("STAGE_INPUT_UNREADABLE", f"{role}: {exc}") from exc
        if not isinstance(doc, dict):
            raise InvalidStageInput(
                "STAGE_INPUT_NOT_OBJECT", f"{role} 必須是 JSON object"
            )
        return doc

    def sigmas_input(self) -> ResolvedInput:
        """Return the stage input containing the sigma schedule."""
        for spec in self._spec_inputs():
            artifact = spec.get("artifact") or {}
            if (
                spec.get("name") == "sigmas"
                or artifact.get("media_type") == media_types.SIGMA_GRID
            ):
                item = self.ctx.inputs.get(str(spec["name"]))
                if item is not None and item.path is not None:
                    return ResolvedInput(item.name, Path(item.path), item.artifact)
        item = self.ctx.inputs.get("sigmas")
        if item is None or item.path is None:
            raise InvalidStageInput(
                "SIGMAS_INPUT_MISSING",
                f"{self.kind} 缺少 plan sigma grid artifact（sigmas）",
            )
        return ResolvedInput(item.name, Path(item.path), item.artifact)

    def material_inputs(self) -> dict[int, StageInput]:
        """Return the material inputs supplied to this stage."""
        found: dict[int, StageInput] = {}
        for name, item in self.ctx.inputs.items():
            match = _MATERIAL_RE.match(name)
            if match:
                found[int(match.group(1))] = item
        return dict(sorted(found.items()))

    def attachment(self, artifact_id: str) -> Path:
        """Find the attachment associated with a published artifact."""
        path = self.ctx.attachments.get(artifact_id)
        if path is None:
            raise InvalidStageInput("ATTACHMENT_MISSING", f"缺少附件 {artifact_id}")
        return Path(path)

    # -- progress / cancel / diagnostics -------------------------------------
    def progress(
        self,
        phase: str,
        unit: str,
        completed: int | None,
        total: int | None,
        **arguments: Unpack[_LoopProgress],
    ) -> None:
        """Publish the current stage progress."""
        validate_keywords(arguments, _LoopProgress)
        completed_updates = arguments.get("completed_updates")
        planned_updates = arguments.get("planned_updates")
        actual_dit_evaluations = arguments.get("actual_dit_evaluations")
        self.ctx.progress(
            {
                "phase": phase,
                "unit": unit,
                "completed": completed,
                "total": total,
                "observed_at": now_rfc3339(),
                "source": "worker_observation",
                "completed_updates": completed_updates,
                "planned_updates": planned_updates,
                "actual_dit_evaluations": actual_dit_evaluations,
            }
        )

    def check_cancel(self) -> None:
        """Interrupt the stage if cancellation has been requested."""
        self.ctx.cancel.raise_if_set()

    def info(self, code: str, message: str, **kwargs: Any) -> None:
        """Record an informational stage event."""
        self.diagnostics.append(diagnostic(code, message, severity="info", **kwargs))

    def warn(self, code: str, message: str, **kwargs: Any) -> None:
        """Record a stage warning."""
        self.diagnostics.append(diagnostic(code, message, severity="warning", **kwargs))

    def fact(self, code: str, payload: Mapping[str, Any]) -> None:
        """Small structured runtime fact as an info diagnostic (JSON text)."""
        text = json.dumps(
            dict(payload), ensure_ascii=False, sort_keys=True, default=str
        )
        self.info(code, text[:2000])

    def measure(
        self,
        *,
        compute_seconds: float | None = None,
        per_step_seconds: Sequence[float] | None = None,
        flop: AnalyticFlop | None = None,
        **detail: Any,
    ) -> None:
        """Record the stage's compute timing / analytic FLOPs (``measure.py``; the provider reports them)."""
        if compute_seconds is not None:
            self.measurements["compute_seconds"] = round(float(compute_seconds), 6)
        if per_step_seconds is not None:
            self.measurements["per_step_seconds"] = [
                round(float(s), 6) for s in per_step_seconds
            ]
        if flop is not None:
            self.measurements["analytic_flop"] = float(flop.total)
            self.measurements["analytic_flop_detail"] = dict(flop.detail)
        if detail:
            self.measurements.setdefault("detail", {}).update(detail)

    def cost(
        self,
        stage: str,
        *,
        work: float,
        unit: str,
        seconds: float | None = None,
        **shape: float | str,
    ) -> None:
        """Add to the call's ETA work record (the sizes this stage really ran with, never a prediction).

        ``stage`` / ``unit`` follow the ETA cost model (``encode`` in ``flop``, ``encode_image`` in
        ``pixel`` …; ``measure.COST_STAGES``).  Calls with the same ``stage`` add up into one entry
        (``work``, ``seconds`` and the numeric ``shape`` facts; ``shape.items`` counts the calls), as the
        cost model predicts one amount per stage and call — so a stage that can repeat passes only
        additive facts.  Record the work before it runs (``seconds=None``) when a failed stage should
        still report its size, and add the measured time with :meth:`cost_seconds`.
        """
        if COST_STAGES.get(stage) != unit:
            raise ValueError(
                f"cost stage {stage!r} in {unit!r}: measure.COST_STAGES says {COST_STAGES.get(stage)!r}"
            )
        entries: dict[str, dict[str, Any]] = self.measurements.setdefault("cost", {})
        entry = entries.get(stage)
        if entry is None:
            entries[stage] = {
                "stage": stage,
                "work": float(work),
                "unit": unit,
                "seconds": None if seconds is None else float(seconds),
                "shape": {**shape, "items": 1},
            }
            return
        entry["work"] += float(work)
        if seconds is not None:
            entry["seconds"] = (entry["seconds"] or 0.0) + float(seconds)
        facts = entry["shape"]
        for key, value in shape.items():
            old = facts.get(key)
            numeric = all(
                isinstance(v, (int, float)) and not isinstance(v, bool)
                for v in (old, value)
            )
            facts[key] = old + value if numeric else value
        facts["items"] += 1

    def cost_seconds(self, stage: str, seconds: float) -> None:
        """Add the measured compute time to the entry :meth:`cost` recorded for ``stage``."""
        entry = (self.measurements.get("cost") or {}).get(stage)
        if entry is not None:
            entry["seconds"] = (entry["seconds"] or 0.0) + float(seconds)

    def result(self) -> StageResult:
        """Build the result with the published files and observations."""
        return StageResult(
            status="succeeded",
            outputs=list(self.outputs),
            diagnostics=list(self.diagnostics),
            active_profile_digest=self.policy.active_profile_digest,
        )


def adapter_digest() -> str:
    """Identity of the producer for tensor-bundle manifests.

    tensor-bundle.schema.json requires ``adapter_digest`` but does not define what it
    hashes; this is the shim's stand-in until the contract says (open interface issue).
    """
    return canonical_digest(
        {
            "family": FAMILY,
            "runtime_provider": PROVIDER_ID,
            "runtime_provider_version": PROVIDER_VERSION,
            "sglang_source_revision": SGLANG_SOURCE_REVISION,
        }
    )


def requested(plan: Mapping[str, Any]) -> Mapping[str, Any]:
    """Read the requested stage setting from the frozen plan."""
    return plan.get("requested") or {}


def task_of(plan: Mapping[str, Any]) -> str:
    """Return the task declared in the H3 job."""
    task = str(requested(plan).get("task", "")).lower()
    if task not in ("t2va", "fl2va", "ref2va"):
        raise InvalidStageInput("TASK_UNKNOWN", f"未知 H3 task：{task!r}")
    return task


def seed_of(plan: Mapping[str, Any]) -> int:
    """Return the seed declared in the H3 job."""
    seed = (requested(plan).get("sampling") or {}).get("seed")
    try:
        value = parse_seed(seed)
    except ValueError as exc:
        raise InvalidStageInput(
            "SEED_INVALID", str(exc), field_path="sampling.seed"
        ) from exc
    if value > PINNED_SGLANG_MAX_SEED:
        # pinned validator caps at 2^63-1 (request_validation.py:41) and audio
        # condition noise reseeds with seed+1 (condition_noise.py:177); never remap
        raise InvalidStageInput(
            "SEED_ABOVE_PINNED_RUNTIME_RANGE",
            f"seed {value} 超過釘版 SGLang 上限 2^63-1；shim 不重新映射 seed",
            field_path="sampling.seed",
        )
    return value


# A prepared reference video whose soundtrack was left out on request (``use_embedded_audio: false``)
SOUNDTRACK_DROPPED_KEY = "soundtrack_dropped"
_VIDEO_CHAINS = ("video.reference_preserve", "video_audio.reference_preserve")


def contributes_audio(material: Mapping[str, Any]) -> bool:
    """Whether a prepared material contributes audio: an ``<Audio j>`` label, a waveform and an audio block.

    The one rule every stage reads (presentation labels, the audio encode's sources, the AdaLN flags):
    a reference audio always; a ``video_audio`` video always (the caller's promise, as upstream); a plain
    ``video`` video when its probed file has a soundtrack (``input_has_audio``, upstream's rule,
    ``S/stages/text_encoding.py:445-470``) that was not dropped on request (``soundtrack_dropped``,
    the shim's ``use_embedded_audio: false``).  The prepared entry carries the decoded waveform
    (``audio``) exactly when the rule says so; a document where the two disagree is refused, so an
    opted-out soundtrack can never reach the conditioning text or the audio partial.
    """
    chain = material.get("material_chain")
    if chain == "audio":
        return True
    if chain not in _VIDEO_CHAINS:
        return False
    wanted = chain == "video_audio.reference_preserve" or (
        bool(material.get("input_has_audio"))
        and material.get(SOUNDTRACK_DROPPED_KEY) is not True
    )
    if wanted != bool(material.get("audio")):
        raise InvalidStageInput(
            "REFERENCE_AUDIO_INCONSISTENT",
            f"materials[{material.get('material_index')}]：參考影片的原聲狀態不一致"
            f"（input_has_audio={material.get('input_has_audio')!r}、"
            f"{SOUNDTRACK_DROPPED_KEY}={material.get(SOUNDTRACK_DROPPED_KEY)!r}、"
            f"waveform={'有' if material.get('audio') else '無'}）；請以目前版本重跑 prepare_media",
        )
    return wanted


__all__ = [
    "SOUNDTRACK_DROPPED_KEY",
    "StageRun",
    "adapter_digest",
    "contributes_audio",
    "requested",
    "seed_of",
    "task_of",
]
