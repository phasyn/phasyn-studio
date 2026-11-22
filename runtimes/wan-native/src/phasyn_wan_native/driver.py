"""Standalone bridge to the fixed official Wan implementation inside the offline child."""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import resource
import runpy
import sys
import time
from importlib import import_module
from importlib.metadata import distributions, version
from pathlib import Path
from typing import Any


_ENGINE = Path("/engine")
_JOB = Path("/job")
_WEIGHTS = Path("/weights")
_REFERENCE = "/job/reference.png"


def _stamp(info: os.stat_result) -> list[int]:
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _verify_mounts(inventory: dict[str, Any]) -> None:
    # Inode times alone cannot distinguish same-size changes within one filesystem tick.
    for name, expected in inventory.items():
        with (_WEIGHTS / name).open("rb") as handle:
            if _stamp(os.fstat(handle.fileno())) != expected["stamp"]:
                raise ValueError("mounted checkpoint identity changed")
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if (
                digest != expected["sha256"]
                or _stamp(os.fstat(handle.fileno())) != expected["stamp"]
            ):
                raise ValueError("mounted checkpoint content changed")


def _prepare_performance(size: str) -> None:
    script = _ENGINE / "wan/modules/animate/preprocess/preprocess_data.py"
    sys.path.insert(0, str(script.parent))
    try:
        sys.argv = [
            str(script),
            "--ckpt_path",
            "/weights/process_checkpoint",
            "--video_path",
            "/input/driving",
            "--refer_path",
            _REFERENCE,
            "--save_path",
            "/job/processed",
            "--resolution_area",
            *size.split("*"),
            "--fps",
            "30",
            "--retarget_flag",
        ]
        runpy.run_path(str(script), run_name="__main__")
    finally:
        sys.path.remove(str(script.parent))
    for name in ("src_ref.png", "src_face.mp4", "src_pose.mp4"):
        if not (_JOB / "processed" / name).is_file():
            raise ValueError("missing official Animate preprocessing output")


def _preflight(role: str) -> None:
    sys.path.insert(0, str(_ENGINE))
    torch = import_module("torch")
    native = import_module("wan")
    config_name = "s2v-14B" if role == "speech" else "animate-14B"
    config = import_module("wan.configs").WAN_CONFIGS[config_name]
    constructor = native.WanS2V if role == "speech" else native.WanAnimate
    probe = {
        "role": role,
        "prompt": "",
        "steps": 1,
        "seed": 0,
        "chunk_frames": 32,
        "size": "832*480",
    }
    inspect.signature(constructor.generate).bind(
        None, **_native_arguments(probe, config)
    )
    if role == "performance":
        directory = _ENGINE / "wan/modules/animate/preprocess"
        sys.path.insert(0, str(directory))
        try:
            runpy.run_path(str(directory / "preprocess_data.py"))
        finally:
            sys.path.remove(str(directory))
    # Exercise Wan's real FA2 variable-length code path without loading checkpoint files.
    sample = torch.ones((1, 2, 1, 64), dtype=torch.bfloat16, device="cuda:0")
    result = import_module("wan.modules.attention").flash_attention(
        sample, sample, sample, version=2
    )
    if result.shape != sample.shape or not torch.equal(result, sample):
        raise RuntimeError("unexpected native attention result")
    report = {
        "role": role,
        "config": config_name,
        "sample_fps": int(config.sample_fps),
        "torch": str(torch.__version__),
        "cuda": torch.version.cuda,
        "flash_attention": version("flash-attn"),
        "device": torch.cuda.get_device_name(0),
        "native_import": True,
        "native_fa2": True,
        "preprocessing_import": role == "performance",
    }
    if role == "performance":
        # Include the pinned preprocessing code, local bridge, decoder, installed wheels and CUDA identity.
        packages = sorted((str(d.metadata["Name"]), d.version) for d in distributions())
        abi = hashlib.sha256(json.dumps([report, packages], sort_keys=True).encode())
        for executable in (Path(__file__), Path("/tools/ffmpeg")):
            with executable.open("rb") as content:
                abi.update(hashlib.file_digest(content, "sha256").digest())
        report["conditioning_abi"] = abi.hexdigest()
    (_JOB / "preflight.json").write_text(json.dumps(report), encoding="utf-8")


def _native_arguments(opts: dict[str, Any], config: Any) -> dict[str, Any]:
    common = {
        "input_prompt": opts["prompt"],
        "sampling_steps": opts["steps"],
        "seed": opts["seed"],
        "sample_solver": "unipc",
        "shift": config.sample_shift,
        "guide_scale": config.sample_guide_scale,
        "offload_model": True,
    }
    if opts["role"] == "speech":
        return dict(
            **common,
            ref_image_path=_REFERENCE,
            audio_path="/job/conditioning.wav",
            enable_tts=False,
            tts_prompt_audio=None,
            tts_prompt_text=None,
            tts_text=None,
            num_repeat=None,
            max_area=import_module("wan.configs").MAX_AREA_CONFIGS[opts["size"]],
            infer_frames=opts["chunk_frames"],
            init_first_frame=False,
        )
    # Explicitly forward the Animate prompt, which the upstream CLI omits.
    return {
        **common,
        "src_root_path": "/job/processed",
        "refert_num": 1,
        "replace_flag": False,
        "clip_len": opts["chunk_frames"],
    }


def _generate(opts: dict[str, Any]) -> dict[str, int]:
    sys.path.insert(0, str(_ENGINE))
    native = import_module("wan")
    cuda = import_module("torch").cuda
    cuda.reset_peak_memory_stats(0)
    configs = import_module("wan.configs")
    speech = opts["role"] == "speech"
    config = configs.WAN_CONFIGS["s2v-14B" if speech else "animate-14B"]
    constructor = native.WanS2V if speech else native.WanAnimate
    kwargs = {
        "config": config,
        "checkpoint_dir": str(_WEIGHTS),
        "device_id": 0,
        "t5_cpu": True,
        "convert_model_dtype": opts["convert_model_dtype"],
    }
    strategy = opts["dit_offload"]
    load_start = time.perf_counter_ns()
    model = (
        constructor(**kwargs)
        if strategy == "native"
        else runpy.run_path("/offload.py")["construct"](constructor, strategy, kwargs)
    )
    cuda.synchronize(0)
    sample_start = time.perf_counter_ns()
    video = model.generate(**_native_arguments(opts, config))
    cuda.synchronize(0)
    encode_start = time.perf_counter_ns()
    if speech:
        frames = opts["speech_frames"]
        if video.shape[1] < frames:
            raise ValueError("native video did not cover the conditioning audio")
        video = video[:, :frames]
    frames = int(video.shape[1])
    import_module("wan.utils.utils").save_video(
        tensor=video[None],
        save_file="/job/generated.mp4",
        fps=config.sample_fps,
        nrow=1,
        normalize=True,
        value_range=(-1, 1),
    )
    return {
        "frames": frames,
        "fps": int(config.sample_fps),
        "cuda_peak_allocated_bytes": int(cuda.max_memory_allocated(0)),
        "cuda_peak_reserved_bytes": int(cuda.max_memory_reserved(0)),
        "model_load_ns": sample_start - load_start,
        "sampling_ns": encode_start - sample_start,
        "video_encoding_ns": time.perf_counter_ns() - encode_start,
    }


def _failure_site(exc: Exception) -> str:
    # Only filenames of code under our read-only application and package mounts.
    trace = exc.__traceback__
    last = "-"
    while trace is not None:
        frame = Path(trace.tb_frame.f_code.co_filename)
        if frame.suffix == ".py" and frame.stem.replace("_", "").isalnum():
            last = f"{frame.stem}.{trace.tb_lineno}"
        trace = trace.tb_next
    return last


def main() -> None:
    """Verify the pinned mounts before importing the model or decoding the input media."""
    phase = "integrity"
    try:
        opts = json.loads((_JOB / "options.json").read_bytes())
        if opts.get("preflight") is True:
            phase = "preflight"
            _preflight(opts["role"])
            return
        inventory = json.loads((_JOB / "files.json").read_bytes())
        start = time.perf_counter_ns()
        _verify_mounts(inventory)
        verified = time.perf_counter_ns()
        preprocess_ns = 0
        if opts["role"] == "performance" and not opts.get("prepared_controls"):
            phase = "preprocess"
            _prepare_performance(opts["size"])
            preprocess_ns = time.perf_counter_ns() - verified
        phase = "inference"
        report = _generate(opts)
        phase = "integrity"
        final_check = time.perf_counter_ns()
        _verify_mounts(inventory)
        report.update(
            initial_weight_verification_ns=verified - start,
            final_weight_verification_ns=time.perf_counter_ns() - final_check,
            animate_preprocess_ns=preprocess_ns,
            worker_max_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            * 1024,
        )
        (_JOB / "geometry.json").write_text(json.dumps(report))
    except Exception as exc:  # noqa: BLE001 -- redact every third-party exception at the worker boundary.
        # Do not emit user prompts, managed input paths, upstream tracebacks or file contents.
        missing = exc.name if isinstance(exc, ModuleNotFoundError) else ""
        dependency = (
            missing
            if missing and missing.replace(".", "").replace("_", "").isalnum()
            else "-"
        )
        sys.stderr.write(
            f"\nPHASYN_WAN_ERROR {phase} {type(exc).__name__} {dependency} {_failure_site(exc)}\n"
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
