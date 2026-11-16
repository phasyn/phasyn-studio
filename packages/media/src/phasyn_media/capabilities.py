"""Encoder capabilities and codec routing.

Capabilities come from the encoders actually compiled into the node's FFmpeg
(``ffmpeg -encoders``), never from package names.  NVENC entries add the
per-GPU generation rule (NVIDIA's public "Video Encode and Decode GPU Support Matrix"):

==========================  =====  ==================  ==============
SM (compute capability)     H.264  HEVC 8 / 10-bit     AV1 8 / 10-bit
==========================  =====  ==================  ==============
50-51 (Maxwell 1)           yes    no                  no
52 (Maxwell 2)              yes    8-bit only          no
60, 61, 70, 75, 86          yes    yes                 no (e.g. Ampere sm86)
89 (Ada)                    yes    yes                 yes
>= 120 (Blackwell client)   yes    yes                 yes (e.g. Blackwell sm120)
80, 90, 100, 103            no NVENC engine (data-center parts)
53, 62, 72, 87              no desktop NVENC API (Tegra/Jetson)
==========================  =====  ==================  ==============

A documented NVENC entry is ``available=False`` (status ``documented``)
until ``detect_encoder_capabilities(..., probe=True)`` has run a real tiny
encode on that GPU (status ``probe_passed``).  CPU encoders that are compiled
in are available (status ``documented``; ``probe_passed`` after a probe).

``route_codec`` resolution order for ``encode_provider="auto_validated"``:

1. the CPU FFmpeg encoder of the codec (libx264 / libx265 / libsvtav1 >
   libaom-av1) when available and supporting the pixel format — the
   reference path: deterministic, no GPU session/VRAM interaction;
2. NVENC on the stage's own ``device`` when probe-validated for codec and
   pixel format;
3. NVENC on another GPU of the capability list, ordered by device index then
   UUID, when probe-validated (e.g. AV1 requested on an sm86 GPU -> an sm89/sm120 GPU);
4. otherwise refused with ``NO_VALIDATED_PROVIDER`` (the plan is blocked).

An explicit ``cpu_ffmpeg`` or ``nvenc`` request is never silently replaced:
it is either honoured exactly or refused with a reason.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from typing import Any

from .encode import CODECS, CPU_ENCODERS, NVENC_ENCODERS, PIXEL_FORMATS, encoder_args, video_filter
from .errors import MediaError
from .mux import AUDIO_CODECS, CONTAINERS, MP4_PCM_MESSAGE, mp4_pcm_conflict
from .tools import encoder_pixel_formats, find_ffmpeg, list_encoders, run_tool, summarize_stderr, tool_env

CPU = "cpu_ffmpeg"
NVENC = "nvenc"
AUTO = "auto_validated"
PROVIDER_CHOICES = (AUTO, CPU, NVENC)

STATUS_DOCUMENTED = "documented"
STATUS_PROBE_PASSED = "probe_passed"
STATUS_UNSUPPORTED = "unsupported"

NO_NVENC_ENGINE_SM = frozenset({80, 90, 100, 103})
NO_DESKTOP_NVENC_SM = frozenset({53, 62, 72, 87})
_PROBE_SIZE = (256, 256)
_PROBE_FRAMES = 3


@dataclass(frozen=True)
class EncoderCapability:
    codec: str
    provider: str
    encoder_name: str
    device_uuid: str | None
    pixel_formats: tuple[str, ...]
    available: bool
    reason: str
    status: str = STATUS_DOCUMENTED
    reason_code: str = "DOCUMENTED"
    device_index: int | None = None
    device_name: str | None = None
    sm: int | None = None

    @property
    def capability_id(self) -> str:
        base = f"media.encode.{self.codec}.{self.provider}"
        return f"{base}.{self.device_uuid}"[:128] if self.device_uuid else base

    def as_dict(self) -> dict[str, Any]:
        doc = asdict(self)
        doc["pixel_formats"] = list(self.pixel_formats)
        doc["capability_id"] = self.capability_id
        return doc


@dataclass(frozen=True)
class RouteDecision:
    allowed: bool
    provider: str | None
    encoder_name: str | None
    device_uuid: str | None
    reason_code: str
    reason: str
    field_paths: tuple[str, ...] = ()
    requested_provider: str | None = None
    device_index: int | None = None

    def as_dict(self) -> dict[str, Any]:
        doc = asdict(self)
        doc["field_paths"] = list(self.field_paths)
        return doc


# --------------------------------------------------------------------------- device facts


def parse_sm(value: Any) -> int | None:
    """Compute capability as an integer: ``"8.6"``/``"86"``/``86``/``(8, 6)`` -> 86, ``"12.0"`` -> 120."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (tuple, list)) and len(value) == 2 and all(isinstance(v, int) for v in value):
        return int(value[0]) * 10 + int(value[1])
    if isinstance(value, int):
        return value if value >= 10 else None
    text = str(value).strip().lower().removeprefix("sm_").removeprefix("sm")
    match = re.fullmatch(r"(\d{1,2})\.(\d)", text)
    if match:
        return int(match.group(1)) * 10 + int(match.group(2))
    if re.fullmatch(r"\d{2,3}", text):
        return int(text)
    return None


def _device_facts(device: Mapping[str, Any]) -> tuple[int | None, str | None, str | None, int | None, str]:
    index = device.get("index", device.get("device_index"))
    index = index if isinstance(index, int) and not isinstance(index, bool) else None
    uuid = device.get("uuid") or device.get("device_uuid")
    uuid = str(uuid) if uuid else None
    name = device.get("name")
    kind = str(device.get("kind") or "cuda")
    return index, uuid, (str(name) if name else None), parse_sm(device.get("sm")), kind


def nvenc_rule(codec: str, sm: int | None) -> tuple[tuple[str, ...], str, str]:
    """Documented NVENC pixel formats for a GPU generation: (formats, reason_code, reason)."""
    if sm is None:
        return (), "DEVICE_SM_UNKNOWN", "無法判定 GPU 世代（SM），不登記 NVENC 能力"
    if sm in NO_NVENC_ENGINE_SM:
        return (), "NVENC_ABSENT", f"sm{sm} 為資料中心 GPU，沒有 NVENC 編碼引擎"
    if sm in NO_DESKTOP_NVENC_SM:
        return (), "NVENC_ABSENT", f"sm{sm}（Tegra/Jetson）不提供桌面 NVENC API"
    if sm < 50:
        return (), "NVENC_GENERATION_TOO_OLD", f"sm{sm} 世代過舊，不登記 NVENC"
    if codec == "h264":
        return ("yuv420p",), "DOCUMENTED", "支援矩陣：H.264 NVENC（8-bit 4:2:0）"
    if codec == "hevc":
        if sm < 52:
            return (), "NVENC_HEVC_UNSUPPORTED", f"sm{sm} 的 NVENC 不支援 HEVC 編碼"
        if sm < 60:
            return ("yuv420p",), "DOCUMENTED", "支援矩陣：HEVC NVENC 僅 8-bit"
        return ("yuv420p", "yuv420p10le"), "DOCUMENTED", "支援矩陣：HEVC NVENC 8/10-bit"
    if codec == "av1":
        if sm == 89 or sm >= 120:
            return ("yuv420p", "yuv420p10le"), "DOCUMENTED", "支援矩陣：AV1 NVENC 8/10-bit"
        return (), "NVENC_AV1_UNSUPPORTED", f"sm{sm} 的 NVENC 不支援 AV1 編碼"
    return (), "INVALID_ARGUMENT", f"未知 codec {codec}"


# --------------------------------------------------------------------------- detection


# FFmpeg/NVENC failure text -> reason code (fatal ones make other pixel formats pointless)
_PROBE_FAILURES: tuple[tuple[str, str, bool], ...] = (
    ("required nvenc api version", "NVENC_DRIVER_TOO_OLD", True),
    ("minimum required nvidia driver", "NVENC_DRIVER_TOO_OLD", True),
    ("cannot load libnvidia-encode", "NVENC_DRIVER_MISSING", True),
    ("cannot load libcuda", "NVENC_DRIVER_MISSING", True),
    ("no capable devices found", "NVENC_NO_DEVICE", True),
    ("no nvenc capable devices", "NVENC_NO_DEVICE", True),
    ("no device available", "NVENC_NO_DEVICE", True),
    ("openencodesessionex failed", "NVENC_SESSION_FAILED", False),
    ("out of memory", "NVENC_SESSION_FAILED", False),
)


FATAL_PROBE_CODES = frozenset(code for _needle, code, fatal in _PROBE_FAILURES if fatal)


def classify_probe_failure(text: str) -> tuple[str, bool]:
    """(reason_code, fatal_for_device) for a failed probe encode."""
    lowered = text.lower()
    for needle, code, fatal in _PROBE_FAILURES:
        if needle in lowered:
            return code, fatal
    return "PROBE_FAILED", False


def _probe_encode(
    ffmpeg: str, encoder_name: str, pixel_format: str, *, env_extra: Mapping[str, str], timeout: float
) -> tuple[bool, str]:
    """Encode a few tiny frames to the null muxer; returns (passed, root-cause reason)."""
    width, height = _PROBE_SIZE
    argv = [
        ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-protocol_whitelist", "pipe",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", f"{width}x{height}", "-framerate", "24/1",
        "-i", "pipe:0",
        "-vf", video_filter(pixel_format, encoder_name),
        *encoder_args(encoder_name, quality=23, pixel_format=pixel_format, container="mkv"),
        "-f", "null", "-",
    ]  # fmt: skip
    try:
        result = run_tool(
            argv,
            timeout=timeout,
            stdin_data=bytes(width * height * 3 * _PROBE_FRAMES),
            env=tool_env(dict(env_extra)),
            max_stdout_bytes=1 << 20,
            what=f"{encoder_name} probe",
        )
    except MediaError as exc:
        return False, exc.message
    if result.returncode == 0:
        return True, ""
    return False, summarize_stderr(result.stderr, 600) or f"exit {result.returncode}"


def detect_encoder_capabilities(
    gpus: Iterable[Mapping[str, Any]],
    *,
    ffmpeg: str | None = None,
    probe: bool = False,
    codecs: Sequence[str] | None = None,
    probe_timeout_seconds: float = 30.0,
) -> list[EncoderCapability]:
    """CPU + per-GPU NVENC encoder capabilities of this node's FFmpeg build.

    ``gpus`` items: ``{"index", "uuid", "name", "sm"}`` (``device_index`` /
    ``device_uuid`` aliases accepted; ``kind="cpu"`` entries are skipped).
    With ``probe=True`` every documented entry is exercised by a real tiny
    encode (NVENC pinned through ``CUDA_VISIBLE_DEVICES=<uuid>``).
    """
    exe = ffmpeg or find_ffmpeg()
    built = list_encoders(exe)
    wanted = tuple(codecs) if codecs is not None else CODECS
    for codec in wanted:
        if codec not in CODECS:
            raise MediaError("INVALID_ARGUMENT", f"未知 codec：{codec}")
    out: list[EncoderCapability] = []

    for codec in wanted:
        name = next((n for n in CPU_ENCODERS[codec] if n in built), None)
        if name is None:
            out.append(
                EncoderCapability(
                    codec=codec,
                    provider=CPU,
                    encoder_name=CPU_ENCODERS[codec][0],
                    device_uuid=None,
                    pixel_formats=(),
                    available=False,
                    reason=f"此 FFmpeg 建置沒有 {' / '.join(CPU_ENCODERS[codec])}",
                    status=STATUS_UNSUPPORTED,
                    reason_code="ENCODER_NOT_BUILT",
                )
            )
            continue
        supported = set(encoder_pixel_formats(name, exe))
        formats = tuple(f for f in PIXEL_FORMATS if f in supported)
        cap = EncoderCapability(
            codec=codec,
            provider=CPU,
            encoder_name=name,
            device_uuid=None,
            pixel_formats=formats,
            available=bool(formats),
            reason=f"FFmpeg 建置包含 {name}" if formats else f"{name} 不支援 yuv420p/yuv420p10le",
            status=STATUS_DOCUMENTED if formats else STATUS_UNSUPPORTED,
            reason_code="DOCUMENTED" if formats else "PIXEL_FORMAT_UNSUPPORTED",
        )
        if probe and formats:
            cap = _apply_probe(cap, exe, {}, probe_timeout_seconds)
        out.append(cap)

    facts = sorted(
        (_device_facts(g) for g in gpus if str(g.get("kind") or "cuda") == "cuda"),
        key=lambda f: (f[0] if f[0] is not None else 1 << 30, str(f[1])),
    )
    for index, uuid, name, sm, _kind in facts:
        fatal: EncoderCapability | None = None  # e.g. driver too old: same verdict for every codec
        for codec in wanted:
            encoder = NVENC_ENCODERS[codec]
            formats, code, reason = nvenc_rule(codec, sm)
            if encoder not in built:
                formats, code, reason = (), "ENCODER_NOT_BUILT", f"此 FFmpeg 建置沒有 {encoder}"
            base = EncoderCapability(
                codec=codec,
                provider=NVENC,
                encoder_name=encoder,
                device_uuid=uuid,
                pixel_formats=formats,
                available=False,
                reason=reason if not formats else f"{reason}；尚未在此 GPU 實測 probe",
                status=STATUS_DOCUMENTED if formats else STATUS_UNSUPPORTED,
                reason_code="NOT_PROBED" if formats else code,
                device_index=index,
                device_name=name,
                sm=sm,
            )
            if probe and formats:
                if uuid is None and index is None:
                    base = replace(base, reason="缺少 GPU uuid/index，無法 probe", reason_code="DEVICE_UNKNOWN")
                elif fatal is not None:
                    base = replace(
                        base,
                        pixel_formats=(),
                        status=STATUS_UNSUPPORTED,
                        reason_code=fatal.reason_code,
                        reason=f"同一 GPU 先前 probe 已失敗（{fatal.encoder_name}）：{fatal.reason}"[:2000],
                    )
                else:
                    env = {"CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": uuid or str(index)}
                    base = _apply_probe(base, exe, env, probe_timeout_seconds)
                    if base.reason_code in FATAL_PROBE_CODES:
                        fatal = base
            out.append(base)
    return out


def _apply_probe(cap: EncoderCapability, ffmpeg: str, env: Mapping[str, str], timeout: float) -> EncoderCapability:
    passed: list[str] = []
    failures: list[str] = []
    failure_code = "PROBE_FAILED"
    for pixel_format in cap.pixel_formats:
        ok, why = _probe_encode(ffmpeg, cap.encoder_name, pixel_format, env_extra=env, timeout=timeout)
        if ok:
            passed.append(pixel_format)
            continue
        failures.append(f"{pixel_format}: {why}")
        failure_code, fatal = classify_probe_failure(why)
        if fatal:  # e.g. driver too old: every pixel format fails the same way
            break
    if passed:
        note = "實測 probe 通過：" + ", ".join(passed)
        if failures:
            note += "；未通過：" + "；".join(failures)
        return replace(
            cap,
            pixel_formats=tuple(passed),
            available=True,
            status=STATUS_PROBE_PASSED,
            reason_code="PROBE_PASSED",
            reason=note[:2000],
        )
    return replace(
        cap,
        pixel_formats=(),
        available=False,
        status=STATUS_UNSUPPORTED,
        reason_code=failure_code,
        reason=("實測 probe 失敗：" + "；".join(failures))[:2000],
    )


# --------------------------------------------------------------------------- routing


def _refuse(code: str, reason: str, fields: Sequence[str], requested: str | None) -> RouteDecision:
    return RouteDecision(False, None, None, None, code, reason, tuple(fields), requested)


def _allow(cap: EncoderCapability, code: str, reason: str, requested: str) -> RouteDecision:
    return RouteDecision(
        True,
        cap.provider,
        cap.encoder_name,
        cap.device_uuid,
        code,
        reason,
        ("output.encode_provider",),
        requested,
        cap.device_index,
    )


def _label(cap: EncoderCapability) -> str:
    if cap.provider == CPU:
        return f"CPU FFmpeg {cap.encoder_name}"
    who = cap.device_name or cap.device_uuid or f"GPU {cap.device_index}"
    return f"{who} {cap.encoder_name}"


def route_codec(
    *,
    codec: str,
    pixel_format: str,
    container: str,
    audio_codec: str,
    provider: str,
    device: Mapping[str, Any] | None,
    capabilities: Iterable[EncoderCapability],
) -> RouteDecision:
    """Decide the concrete encoder for an output request (frozen into the plan)."""
    fields = {
        "codec": "output.video_codec",
        "pixel_format": "output.pixel_format",
        "container": "output.container",
        "audio_codec": "output.audio_codec",
        "provider": "output.encode_provider",
    }
    for key, value, allowed in (
        ("codec", codec, CODECS),
        ("pixel_format", pixel_format, PIXEL_FORMATS),
        ("container", container, tuple(CONTAINERS)),
        ("audio_codec", audio_codec, AUDIO_CODECS),
        ("provider", provider, PROVIDER_CHOICES),
    ):
        if value not in allowed:
            return _refuse(
                "INVALID_ARGUMENT", f"{fields[key]} 不在允許清單：{', '.join(allowed)}", [fields[key]], provider
            )
    if mp4_pcm_conflict(container, audio_codec):
        return _refuse("MP4_PCM_UNSUPPORTED", MP4_PCM_MESSAGE, [fields["container"], fields["audio_codec"]], provider)
    caps = list(capabilities)
    device_uuid = None
    if device is not None:
        _index, device_uuid, _name, _sm, kind = _device_facts(device)
        if kind != "cuda":
            device_uuid = None

    def usable(cap: EncoderCapability) -> bool:
        return cap.codec == codec and cap.available and pixel_format in cap.pixel_formats

    def find(prov: str, uuid: str | None) -> EncoderCapability | None:
        return next((c for c in caps if c.codec == codec and c.provider == prov and c.device_uuid == uuid), None)

    def nvenc_order(cap: EncoderCapability) -> tuple[int, str]:
        return (cap.device_index if cap.device_index is not None else 1 << 30, cap.device_uuid or "")

    codec_fields = [fields["codec"], fields["provider"]]
    if provider == CPU:
        cap = find(CPU, None)
        if cap is None or not cap.available:
            reason = cap.reason if cap is not None else f"此節點沒有 {codec} 的 CPU 編碼器"
            return _refuse(cap.reason_code if cap is not None else "ENCODER_NOT_BUILT", reason, codec_fields, provider)
        if pixel_format not in cap.pixel_formats:
            return _refuse(
                "PIXEL_FORMAT_UNSUPPORTED",
                f"{cap.encoder_name} 不支援 {pixel_format}",
                [fields["pixel_format"], fields["provider"]],
                provider,
            )
        return _allow(cap, "OK", f"使用 {_label(cap)}", provider)

    if provider == NVENC:
        if device is not None:
            if device_uuid is None:
                return _refuse("DEVICE_NOT_CUDA", "指定的裝置不是可用 NVENC 的 CUDA GPU", codec_fields, provider)
            cap = find(NVENC, device_uuid)
            if cap is None:
                return _refuse("DEVICE_UNKNOWN", "此裝置沒有登記的 NVENC 能力", codec_fields, provider)
            if cap.status == STATUS_UNSUPPORTED:
                return _refuse(
                    cap.reason_code,
                    f"{cap.reason}；不會自動改派其他 provider，如需改派請選 auto_validated",
                    codec_fields,
                    provider,
                )
            if pixel_format not in cap.pixel_formats:
                return _refuse(
                    "PIXEL_FORMAT_UNSUPPORTED",
                    f"{_label(cap)} 不支援 {pixel_format}",
                    [fields["pixel_format"], fields["provider"]],
                    provider,
                )
            if not cap.available:
                return _refuse(
                    "NVENC_NOT_PROBED", f"{_label(cap)} 尚未通過實測 probe，不能派工", codec_fields, provider
                )
            return _allow(cap, "OK", f"使用 {_label(cap)}", provider)
        candidates = sorted((c for c in caps if c.provider == NVENC and usable(c)), key=nvenc_order)
        if candidates:
            return _allow(candidates[0], "OK", f"使用 {_label(candidates[0])}", provider)
        return _refuse("NO_VALIDATED_PROVIDER", f"沒有已驗證的 {codec} NVENC（{pixel_format}）", codec_fields, provider)

    # auto_validated
    cpu = find(CPU, None)
    if cpu is not None and usable(cpu):
        return _allow(cpu, "ROUTED_CPU", f"auto_validated：{_label(cpu)}", provider)
    same = find(NVENC, device_uuid) if device_uuid is not None else None
    if same is not None and usable(same):
        return _allow(same, "ROUTED_NVENC_SAME_DEVICE", f"auto_validated：{_label(same)}", provider)
    others = sorted(
        (c for c in caps if c.provider == NVENC and c.device_uuid != device_uuid and usable(c)), key=nvenc_order
    )
    if others:
        why = f"（{same.reason}）" if same is not None and same.status == STATUS_UNSUPPORTED else ""
        return _allow(
            others[0], "ROUTED_NVENC_OTHER_DEVICE", f"auto_validated：改派 {_label(others[0])}{why}", provider
        )
    reasons = [f"{_label(c)}：{c.reason}" for c in caps if c.codec == codec][:6]
    return _refuse(
        "NO_VALIDATED_PROVIDER",
        f"沒有已驗證的 provider 可編碼 {codec}/{pixel_format}；plan 保持 blocked"
        + (f"（{'；'.join(reasons)}）" if reasons else ""),
        [*codec_fields, fields["pixel_format"]],
        provider,
    )
