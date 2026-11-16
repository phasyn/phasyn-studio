#!/usr/bin/env python3
"""CPU test of the reference-row K/V cache across denoise steps (``provider_options.ref_kv_cache``).

GPU-free by construction: every worker sets ``CUDA_VISIBLE_DEVICES=""`` and SGLang's CPU platform before torch
is imported, blocks NVML, and reports whether CUDA was ever initialised (the test fails if it was). Nothing is
downloaded and nothing is written outside ``--work`` (bytecode writing is off).

It runs the real pinned SGLang H3 code of a GPU runtime tuple's environment together with this checkout's
``phasyn_h3`` (put first on ``sys.path``): Phasyn's ``build_packed`` (the Ref2VA layout), SGLang's
``MiniMaxH3DenoiseBranch``, ``minimax_h3_denoise_loop`` and ``MiniMaxH3DiTModel`` (4 blocks, 4 heads x 128,
randomly initialised) on the torch-SDPA backend (what ``auto_exact`` resolves to), driven the way
``stages/denoise_av`` drives it. Each configuration runs in its own process.

Checks
  (a) off: ``mode: off`` / null / absent give no policy (the loop of today); a loop run after a skip loop in the
      same process is bit-identical to the baseline and every block has its original attention impl back;
  (b) skip == stage 2-lite ("compute every row, overwrite the reference K/V with the cache", reimplemented here
      independently) for every target row of every step: bit for bit with row-deterministic kernels (attention and
      the FP32 projections computed row by row in FP64, the same in both arms, so no result depends on how many
      rows share a kernel call), and with the default CPU kernels (to bf16 tolerance in general; on this problem
      they happen to be exact too); FP8 and BF16 caches; the cache took effect (both differ from the baseline);
  (c) skip steps run only the non-reference rows through every block (rows counted at each block input, QKV,
      out_proj and MLP; attention queries against keys), and the session's analytic FLOP ratio matches the rows;
  (d) refresh_steps / start_step: the step plan, which steps run every row, the cache after each fill (== the FP8
      round trip of that step's own K/V), and the result equals the matching stage-2-lite run;
  plus the memory guard (refuses before step 0), an unsupported backend (refused), the upstream pins and the
  FA-style 4-D output of a backend's dense call.

usage: CUDA_VISIBLE_DEVICES= <runtime>/bin/python -I runtimes/h3/tests/ref_kv_cache_cpu.py [--work DIR]
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # never leave __pycache__ in this checkout or the runtime environment
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for _path in (REPO / "packages/media/src", REPO / "packages/components/src", REPO / "runtimes/h3/src"):
    sys.path.insert(0, str(_path))  # this checkout first, before the runtime environment's own installs

# tiny Ref2VA problem: text 12 (4 Qwen vision rows) | ref image 4 | ref audio 6 | ref video 48 | target audio 6 |
# target video 12 | padding 40. Reference rows [12, 70): 58 of 88 live rows; a skip step runs 30 live rows (+34
# padding = 64) through the blocks instead of 128.
TEXT_LEN = 12
QWEN_TEXT_ROWS = (3, 4, 5, 6)
REF_BLOCKS = [
    {"kind": "image", "latent_h": 4, "latent_w": 4},
    {"kind": "video_audio", "ref_audio_t": 3, "latent_t": 3, "latent_h": 8, "latent_w": 8},
]
LATENT = {"latent_t": 3, "latent_h": 4, "latent_w": 4, "audio_t": 3}
SIGMAS = [1.0, 0.92, 0.8, 0.6, 0.35]  # 4 denoise steps
N_LAYERS, N_HEADS, HEAD_DIM, HIDDEN, FFN = 4, 4, 128, 256, 512
USED, SEQ_LEN, R0, R1 = 88, 128, 12, 70
REDUCED_USED, REDUCED_SEQ = 30, 64
N_STEPS = len(SIGMAS) - 1
LAYER_RE = re.compile(r"blocks\.(\d+)\.attn")


# ===================================================================================================== worker side
def fp8_roundtrip_bf16(torch: Any, x: Any) -> Any:
    """The stage-2-lite FP8 cache, written out independently: per head, one absmax scale over (rows, dims), E4M3,
    back to the K/V dtype."""
    heads = []
    for h in range(int(x.shape[1])):
        x32 = x[:, h].float()
        s = x32.abs().amax().clamp_min(1e-30) / 448.0
        heads.append(((x32 / s).clamp(-448.0, 448.0).to(torch.float8_e4m3fn).float() * s).to(x.dtype))
    return torch.stack(heads, 1)


class Lite:
    """Stage 2-lite, independent of the product code: the full sequence runs every step; on a fill step each
    layer's reference K/V (post-RoPE, as the core gets them) is stored, on a skip step it overwrites them."""

    def __init__(self, torch: Any, plan: list[str], dtype: str) -> None:
        self.torch, self.plan, self.dtype = torch, plan, dtype
        self.cache: dict[int, tuple[Any, Any]] = {}
        self.step: int | None = None
        self.fills = self.replaced = 0

    def core(self, inner: Any) -> Any:
        def core(attention: Any, q: Any, k: Any, v: Any, **kw: Any) -> Any:
            m = LAYER_RE.fullmatch(str(attention.prefix))
            if m is not None and self.step is not None:
                layer, phase = int(m.group(1)), self.plan[self.step]
                if phase == "fill":
                    kr, vr = k[R0:R1], v[R0:R1]
                    if self.dtype == "fp8":
                        self.cache[layer] = (fp8_roundtrip_bf16(self.torch, kr), fp8_roundtrip_bf16(self.torch, vr))
                    else:
                        self.cache[layer] = (kr.clone(), vr.clone())
                    self.fills += 1
                elif phase == "skip":
                    k[R0:R1].copy_(self.cache[layer][0])
                    v[R0:R1].copy_(self.cache[layer][1])
                    self.replaced += 1
            return inner(attention, q, k, v, **kw)

        return core


def run_worker(cfg_path: str) -> int:
    cfg = json.loads(Path(cfg_path).read_text())
    out_dir = Path(cfg["out_dir"])
    os.environ.update(cfg.get("env") or {})
    os.environ.update(
        CUDA_VISIBLE_DEVICES="",
        SGLANG_DIFFUSION_PLATFORM_OVERRIDE="cpu",
        LOCAL_RANK="0",
        RANK="0",
        WORLD_SIZE="1",
        GLOO_SOCKET_IFNAME="lo",
        NCCL_SOCKET_IFNAME="lo",
    )
    import torch

    torch.set_num_threads(2)
    from sglang.multimodal_gen.third_party import pynvml as _nv

    def _blocked(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("NVML blocked by ref_kv_cache_cpu (CPU only)")

    _nv.nvmlInit = _blocked
    real_cap = torch.cuda.get_device_capability
    torch.cuda.get_device_capability = lambda *a, **k: (0, 0)  # the vsa package asks for device 0 at import
    try:
        from sglang.multimodal_gen.runtime.models.dits import minimax_h3 as mh
    finally:
        torch.cuda.get_device_capability = real_cap
    import phasyn_h3
    from phasyn_h3.recipe.adapter import ref_kv_rules as rules
    from phasyn_h3.recipe.runtime import ref_kv_cache as rkv
    from phasyn_h3.recipe.runtime.errors import UnsupportedCombination
    from phasyn_h3.recipe.runtime.stages.layout import LatentDims, build_packed, tagged
    from sglang.multimodal_gen.configs.models.dits.minimax_h3 import MiniMaxH3DiTArchConfig, MiniMaxH3DiTConfig
    from sglang.multimodal_gen.runtime.distributed.parallel_state import (
        maybe_init_distributed_environment_and_model_parallel,
    )
    from sglang.multimodal_gen.runtime.layers.attention.backends import sdpa as sdpa_mod
    from sglang.multimodal_gen.runtime.layers.attention.backends.sdpa import SDPABackend
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3 import denoise_loop as dl
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.denoising import (
        _precompute_refined_prompt_embeds,
        _precompute_rope_cache,
    )
    from sglang.multimodal_gen.runtime.platforms import AttentionBackendEnum, current_platform

    maybe_init_distributed_environment_and_model_parallel(
        tp_size=1,
        sp_size=1,
        cfg_degree=1,
        ulysses_degree=1,
        ring_degree=1,
        dp_size=1,
        distributed_init_method=f"file://{out_dir}/rdv-{os.getpid()}",
    )
    res: dict[str, Any] = {
        "name": cfg["name"],
        "error": None,
        "platform": type(current_platform).__name__,
        "phasyn_h3": str(Path(phasyn_h3.__file__).resolve()),
    }

    # -- the tiny real DiT: deterministic random weights, SDPA bound the way auto_exact resolves ---------------
    arch = MiniMaxH3DiTArchConfig(
        num_layers=N_LAYERS,
        token_refiner_num_layers=1,
        hidden_size=HIDDEN,
        num_attention_heads=N_HEADS,
        attention_head_dim=HEAD_DIM,
        ffn_hidden_size=FFN,
        text_dim=64,
        timestep_input_dim=32,
        time_embed_hidden_size=HIDDEN,
        time_embed_dim=128,
        adaln_out_features=18 * HIDDEN,
        final_adaln_out_features=2 * HIDDEN,
    )
    torch.manual_seed(0)
    model = mh.MiniMaxH3DiTModel(MiniMaxH3DiTConfig(arch_config=arch), hf_config={})
    with torch.no_grad():
        for name, p in model.named_parameters():
            if p.dim() == 1 and "norm" in name:
                p.fill_(1.0)
            else:
                p.normal_(0.0, 0.05)
        model.rope.inv_freq.copy_(10000.0 ** (-torch.arange(0, 32, 2, dtype=torch.float32) / 32))
    model.eval()
    for m in model.modules():
        if isinstance(m, mh.MiniMaxH3Attention):
            m._set_attention_backend(SDPABackend)
    model._resolved_attention_backend = AttentionBackendEnum.TORCH_SDPA
    original_impls = [blk.attn._attention_impl for blk in model.blocks]

    if cfg.get("det"):  # row-deterministic FP32 projections (one row per call, FP64), the same in every arm
        for mod in (
            model.video_patch_proj,
            model.audio_patch_proj,
            model.final_layer.video_out,
            model.final_layer.audio_out,
        ):

            def f64_rows(x: Any, mod: Any = mod) -> tuple[Any, None]:
                w = mod.weight.double()
                b = None if mod.bias is None else mod.bias.double()
                out = x.new_empty((int(x.shape[0]), int(w.shape[0])), dtype=torch.float64)
                for i in range(int(x.shape[0])):
                    out[i : i + 1] = torch.nn.functional.linear(x[i : i + 1].double(), w, b)
                return out.to(x.dtype), None

            mod.forward = f64_rows

    # -- what ran: rows into every block / linear, attention (queries, keys) per step -------------------------
    state: dict[str, Any] = {"step": None}
    rows: dict[str, list[tuple[int | None, int]]] = {"block": [], "qkv": [], "out_proj": [], "fc1": [], "fc2": []}
    attn_calls: list[tuple[int | None, int, int]] = []

    def counter(kind: str) -> Any:
        def hook(_mod: Any, args: Any) -> None:
            x = args[0]
            rows[kind].append((state["step"], int((x[0] if isinstance(x, tuple) else x).shape[0])))

        return hook

    for blk in model.blocks:
        blk.register_forward_pre_hook(counter("block"))
        blk.attn.qkv_proj.register_forward_pre_hook(counter("qkv"))
        blk.attn.out_proj.register_forward_pre_hook(counter("out_proj"))
        blk.mlp.fc1.register_forward_pre_hook(counter("fc1"))
        blk.mlp.fc2.register_forward_pre_hook(counter("fc2"))
    real_sdpa_forward = sdpa_mod.SDPAImpl.forward
    caps: dict[tuple[int, int], dict[str, Any]] = {}
    real_core = mh._minimax_h3_attention_core_impl
    lite = Lite(torch, list(cfg["lite_plan"]), cfg["dtype"]) if cfg["arm"] == "lite" else None

    def install_probes() -> None:
        """The test's own wrappers: attention (queries, keys) per kernel call, and the attention core's inputs and
        output (stage 2-lite outside the capture). They replace pinned upstream objects, so a session is built
        before they go in: its pin check must see the real sources."""

        def sdpa_forward(self: Any, query: Any, key: Any, value: Any, attn_metadata: Any) -> Any:
            if state["step"] is not None:
                attn_calls.append((state["step"], int(query.shape[1]), int(key.shape[1])))
            if not cfg.get("det"):
                return real_sdpa_forward(self, query, key, value, attn_metadata)
            # row-deterministic attention: each query row on its own, FP64 ([B, S, H, D] in, [B, Sq, H, D] out)
            q, k, v = (t.transpose(1, 2).double() for t in (query, key, value))
            out = torch.empty_like(q)
            for i in range(int(q.shape[2])):
                logits = (q[:, :, i : i + 1] @ k.transpose(-1, -2)) * float(self.softmax_scale)
                out[:, :, i : i + 1] = torch.softmax(logits, dim=-1) @ v
            return out.to(query.dtype).transpose(1, 2)

        def capture(attention: Any, q: Any, k: Any, v: Any, **kw: Any) -> Any:
            m = LAYER_RE.fullmatch(str(attention.prefix))
            keep = m is not None and state["step"] is not None and cfg.get("capture")
            if keep:
                ins = (q.detach().clone(), k.detach().clone(), v.detach().clone())
            out = real_core(attention, q, k, v, **kw)
            if keep:
                caps[(int(m.group(1)), int(state["step"]))] = {
                    "q": ins[0],
                    "k": ins[1],
                    "v": ins[2],
                    "out": out.clone(),
                }
            return out

        core = capture if lite is None else lite.core(capture)
        sdpa_mod.SDPAImpl.forward = sdpa_forward
        mh._minimax_h3_attention_core_impl = core
        mh._minimax_h3_attention_core_bcg = mh.eager_on_graph(True)(core)

    # -- Phasyn's own layout (denoise_av: build_packed + tagged), the branch and the two precomputes -----------
    blocks = {"keyframes": [], "ref2va_blocks": REF_BLOCKS, "visual_tensors": [], "audio_tensors": []}
    packed = build_packed("ref2va", TEXT_LEN, LatentDims(**LATENT), blocks, 0)
    text_tags = torch.ones(TEXT_LEN, dtype=torch.long)
    text_tags[list(QWEN_TEXT_ROWS)] = 0
    tags = tagged(packed, text_tags)
    gen = torch.Generator().manual_seed(1)
    emb = torch.randn(TEXT_LEN, 64, generator=gen).to(torch.bfloat16)
    dev = torch.device("cpu")

    def new_branch() -> Any:
        pos = dl.MiniMaxH3DenoiseBranch(packed=packed, text_embeddings=emb, token_tags=tags, device=dev)
        _precompute_refined_prompt_embeds(model, pos, device=dev, shared_conditioning=None)
        _precompute_rope_cache(model, pos, device=dev)
        return pos

    pos = new_branch()
    init_v = torch.randn(int(pos.img_pos.shape[0]), 96, generator=gen)
    init_a = torch.randn(int(pos.audio_pos.shape[0]), 32, generator=gen)
    cond = torch.randn(int((~pos.update_mask).sum()), 96, generator=gen)
    aref = torch.randn(int((~pos.audio_update_mask).sum()), 32, generator=gen)
    res["packed"] = {
        "seq_len": int(packed["seq_len"]),
        "cu": packed["cu_seqlens"].tolist(),
        "img_pos": packed["img_pos"].tolist(),
        "audio_pos": packed["audio_pos"].tolist(),
    }
    res["row_map"] = rkv.row_map_of_branch(pos).as_dict()

    def forward(model_: Any, kwargs: dict[str, Any], step: int) -> Any:  # denoise_av forward(), minus its scopes
        state["step"] = step
        if lite is not None:
            lite.step = step
        try:
            with set_forward_context(current_timestep=step, attn_metadata=None):
                return model_(**kwargs)
        finally:
            state["step"] = None

    def loop(branch: Any, model_forward: Any, on_step: Any) -> tuple[Any, Any]:
        with contextlib.nullcontext():
            return dl.minimax_h3_denoise_loop(
                model=model,
                model_forward=model_forward,
                positive=branch,
                initial_video_rows=init_v,
                initial_audio_rows=init_a,
                keyframe_cond_rows=cond,
                audio_ref_rows=aref,
                sigmas_video=SIGMAS,
                sigmas_audio=SIGMAS,
                device=dev,
                attn_metadata=None,
                on_step=on_step,
            )

    per_step: list[tuple[Any, Any]] = []
    cache_seen: dict[int, dict[int, tuple[Any, Any]]] = {}
    session = None

    def on_step(step: int, video: Any, audio: Any) -> None:
        per_step.append(
            (video[pos.video_target_slice].detach().clone(), audio[pos.audio_target_slice].detach().clone())
        )
        if session is not None and session._complete:  # the cache as the next step would read it
            cache_seen[step] = {layer: session.cached_kv(layer) for layer in range(N_LAYERS)}

    t0 = time.time()
    try:
        if cfg["arm"] == "skip":
            raw = cfg.get("option")
            policy = rules.parse_option(raw)
            res["policy"] = None if policy is None else policy.as_dict()
            if policy is not None:
                if cfg.get("bad_backend"):
                    model.blocks[1].attn._attention_backend_enum = AttentionBackendEnum.SUBBLOCK_SPARSE_ATTN
                session = rkv.RefKvSession(model, pos, policy, steps=N_STEPS, device=dev)
                res["plan"] = list(session.plan)
                install_probes()
                with session.active():
                    res["impl_is_proxy"] = all(
                        type(blk.attn._attention_impl).__name__ == "_ImplProxy" for blk in model.blocks
                    )
                    video, audio = loop(pos, session.wrap_forward(forward), on_step)
                res["report"] = session.report()
                res["warnings"] = session.warnings()
            else:
                install_probes()
                video, audio = loop(pos, forward, on_step)
        else:
            install_probes()
            video, audio = loop(pos, forward, on_step)
        res.update(video=video, audio=audio)
    except UnsupportedCombination as exc:
        res["error"] = f"{exc.reason_code}: {exc.message}"
    except Exception as exc:
        import traceback

        res["error"] = f"{type(exc).__name__}: {exc}"
        res["traceback"] = traceback.format_exc()[-3000:]
    res["loop_s"] = round(time.time() - t0, 3)
    res["per_step"] = per_step
    res["caps"] = caps
    res["cache_seen"] = cache_seen
    res["rows"] = rows
    res["attn_calls"] = attn_calls
    res["impl_restored"] = all(
        blk.attn._attention_impl is impl for blk, impl in zip(model.blocks, original_impls, strict=True)
    )
    if lite is not None:
        res["lite"] = {"fills": lite.fills, "replaced": lite.replaced}

    if cfg.get("then_off") and res["error"] is None:  # the same process, now without any session
        per_step_skip = per_step
        per_step = []
        session = None
        rows_before = {k: len(v) for k, v in rows.items()}
        video2, audio2 = loop(new_branch(), forward, on_step)
        res["then_off"] = {
            "video": video2,
            "audio": audio2,
            "per_step": per_step,
            "rows": {k: v[rows_before[k] :] for k, v in rows.items()},
        }
        res["per_step"] = per_step_skip
    res["cuda_initialized"] = bool(torch.cuda.is_initialized())
    torch.save(res, out_dir / "result.pt")
    return 0


# ===================================================================================================== parent side
class Checks:
    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str]] = []

    def __call__(self, name: str, ok: Any, detail: str = "") -> None:
        self.rows.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""), flush=True)

    @property
    def failed(self) -> list[tuple[str, bool, str]]:
        return [r for r in self.rows if not r[1]]


def spawn_all(py: str, work: Path, configs: list[dict[str, Any]], parallel: int) -> dict[str, dict[str, Any]]:
    procs: list[tuple[str, Any, float]] = []
    done: dict[str, dict[str, Any]] = {}
    pending = list(configs)
    env = dict(os.environ)
    env.update(CUDA_VISIBLE_DEVICES="", SGLANG_DIFFUSION_PLATFORM_OVERRIDE="cpu")
    while pending or procs:
        while pending and len(procs) < parallel:
            cfg = pending.pop(0)
            d = work / cfg["name"]
            d.mkdir(parents=True, exist_ok=True)
            full = {"capture": False, "det": False, "dtype": "fp8", **cfg, "out_dir": str(d)}
            (d / "cfg.json").write_text(json.dumps(full))
            p = subprocess.Popen(
                [py, "-I", "-B", str(Path(__file__).resolve()), "--worker", str(d / "cfg.json")],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            procs.append((cfg["name"], p, time.time()))
        for item in list(procs):
            name, p, t0 = item
            if p.poll() is not None:
                out, err = p.communicate()
                (work / name / "stderr.log").write_text(err)
                done[name] = {"rc": p.returncode, "stdout": out, "stderr": err, "wall_s": round(time.time() - t0, 1)}
                procs.remove(item)
        time.sleep(0.2)
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--work", help="scratch directory (default: a new temporary directory)")
    ap.add_argument("--parallel", type=int, default=4)
    a = ap.parse_args()
    if a.worker:
        return run_worker(a.worker)
    os.environ.update(CUDA_VISIBLE_DEVICES="", SGLANG_DIFFUSION_PLATFORM_OVERRIDE="cpu")
    import torch
    from phasyn_h3.recipe.adapter import ref_kv_rules as rules

    work = Path(a.work or tempfile.mkdtemp(prefix="ref_kv_cache_cpu_")).resolve()
    work.mkdir(parents=True, exist_ok=True)
    print(f"work dir {work}; python {sys.executable}", flush=True)
    chk = Checks()

    skip_fp8 = {"mode": "skip", "start_step": 1, "cache_dtype": "fp8", "refresh_steps": []}
    skip_bf16 = {"mode": "skip", "start_step": 1, "cache_dtype": "bf16", "refresh_steps": []}
    refresh = {"mode": "skip", "start_step": 1, "cache_dtype": "fp8", "refresh_steps": [2]}
    start2 = {"mode": "skip", "start_step": 2, "cache_dtype": "fp8", "refresh_steps": []}
    plan_1 = ["fill", "skip", "skip", "skip"]
    plan_refresh = ["fill", "skip", "fill", "skip"]
    plan_start2 = ["full", "fill", "skip", "skip"]
    configs: list[dict[str, Any]] = [
        {"name": "base", "arm": "base", "capture": True},
        {"name": "base_det", "arm": "base", "det": True},
        {"name": "off", "arm": "skip", "option": {"mode": "off"}},
        {"name": "null", "arm": "skip", "option": None},
        {"name": "skip_fp8", "arm": "skip", "option": skip_fp8, "capture": True},
        {"name": "lite_fp8", "arm": "lite", "lite_plan": plan_1, "capture": True},
        {"name": "skip_fp8_det", "arm": "skip", "option": skip_fp8, "det": True},
        {"name": "lite_fp8_det", "arm": "lite", "lite_plan": plan_1, "det": True},
        {"name": "skip_bf16_det", "arm": "skip", "option": skip_bf16, "det": True, "dtype": "bf16"},
        {"name": "lite_bf16_det", "arm": "lite", "lite_plan": plan_1, "det": True, "dtype": "bf16"},
        {"name": "skip_refresh_det", "arm": "skip", "option": refresh, "det": True, "capture": True},
        {"name": "lite_refresh_det", "arm": "lite", "lite_plan": plan_refresh, "det": True},
        {"name": "skip_start2_det", "arm": "skip", "option": start2, "det": True, "capture": True},
        {"name": "lite_start2_det", "arm": "lite", "lite_plan": plan_start2, "det": True},
        {"name": "skip_then_off", "arm": "skip", "option": skip_fp8, "then_off": True},
        {"name": "budget", "arm": "skip", "option": {**skip_fp8, "max_cache_bytes": 1}},
        {"name": "bad_backend", "arm": "skip", "option": skip_fp8, "bad_backend": True},
    ]
    t0 = time.time()
    procs = spawn_all(sys.executable, work, configs, a.parallel)
    print(f"      {len(configs)} worker processes in {time.time() - t0:.0f} s", flush=True)
    res: dict[str, dict[str, Any]] = {}
    for cfg in configs:
        n = cfg["name"]
        p = procs[n]
        if p["rc"] != 0 or not (work / n / "result.pt").exists():
            chk(f"worker {n} ran", False, (p["stderr"] or "")[-2000:])
            continue
        res[n] = torch.load(work / n / "result.pt", weights_only=False)
    if len(res) != len(configs):
        return 1
    chk(
        "every worker: CPU platform, CUDA never initialised, NVML blocked, this checkout's phasyn_h3",
        all(
            r["platform"] == "CpuPlatform"
            and not r["cuda_initialized"]
            and r["phasyn_h3"].startswith(str(REPO / "runtimes/h3/src"))
            for r in res.values()
        ),
    )
    expected_error = {"budget", "bad_backend"}
    for n, r in res.items():
        if n not in expected_error and r["error"]:
            chk(f"worker {n} loop", False, f"{r['error']}\n{r.get('traceback', '')}")
    if any(res[n]["error"] for n in res if n not in expected_error):
        return 1

    def same(x: Any, y: Any) -> bool:
        return x is not None and y is not None and x.dtype == y.dtype and x.shape == y.shape and torch.equal(x, y)

    def identical(r: dict[str, Any], b: dict[str, Any], *, key: str = "per_step") -> bool:
        return len(r[key]) == len(b[key]) == N_STEPS and all(
            same(a0, b0) and same(a1, b1) for (a0, a1), (b0, b1) in zip(r[key], b[key], strict=True)
        )

    def rel(x: Any, y: Any) -> float:
        return float((x.float() - y.float()).norm() / y.float().norm())

    base = res["base"]
    rm = res["skip_fp8"]["row_map"]
    chk(
        "row map: Phasyn's build_packed layout is text | ref image | ref audio | ref video | target audio | target video",
        base["packed"]["seq_len"] == SEQ_LEN
        and base["packed"]["cu"] == [0, USED, SEQ_LEN]
        and rm["ref_rows"] == [R0, R1]
        and rm["reduced_used"] == REDUCED_USED
        and rm["reduced_seq_len"] == REDUCED_SEQ
        and base["packed"]["img_pos"] == list(range(12, 16)) + list(range(22, 70)) + list(range(76, 88))
        and base["packed"]["audio_pos"] == list(range(16, 22)) + list(range(70, 76)),
        f"{rm}",
    )

    # -- (a) off --------------------------------------------------------------------------------------------------
    chk(
        "(a) mode off and null parse to no policy; the loop of today runs, bit-identical to the baseline",
        res["off"]["policy"] is None
        and res["null"]["policy"] is None
        and identical(res["off"], base)
        and identical(res["null"], base)
        and rules.parse_option(None) is None,
    )
    sto = res["skip_then_off"]
    chk(
        "(a) a loop after a skip loop in the same process: bit-identical to the baseline, original impls back",
        identical(sto["then_off"], base)
        and same(sto["then_off"]["video"], base["video"])
        and same(sto["then_off"]["audio"], base["audio"])
        and sto["impl_restored"]
        and res["skip_fp8"]["impl_is_proxy"],
        "every target row of every step; impl objects identical after the session",
    )
    chk(
        "(a) the skip loop itself differs from the baseline (the cache took effect)",
        not identical(sto, base),
        f"final video rel-L2 vs baseline {rel(sto['video'], base['video']):.4f}",
    )

    # -- (b) skip == stage 2-lite ---------------------------------------------------------------------------------
    for skip, lite, what in (
        ("skip_fp8_det", "lite_fp8_det", "fp8 cache"),
        ("skip_bf16_det", "lite_bf16_det", "bf16 cache"),
        ("skip_refresh_det", "lite_refresh_det", "fp8, refresh_steps [2]"),
        ("skip_start2_det", "lite_start2_det", "fp8, start_step 2"),
    ):
        s, li = res[skip], res[lite]
        chk(
            f"(b) row-deterministic kernels, {what}: skip == stage 2-lite bit for bit, every target row of every step",
            identical(s, li) and same(s["video"], li["video"]) and same(s["audio"], li["audio"]),
            f"plan {s['plan']}; lite fills {li['lite']['fills']}, replaced {li['lite']['replaced']}",
        )
        chk(
            f"(b) {what}: both differ from the exact baseline (the cache took effect)",
            not identical(li, res["base_det"]),
            f"final video rel-L2 lite vs exact {rel(li['video'], res['base_det']['video']):.4f}",
        )
    s, li = res["skip_fp8"], res["lite_fp8"]
    step_rel = [max(rel(a0, b0), rel(a1, b1)) for (a0, a1), (b0, b1) in zip(s["per_step"], li["per_step"], strict=True)]
    cache_effect = rel(li["video"], base["video"])
    chk(
        "(b) default CPU kernels, fp8: skip == stage 2-lite to bf16 tolerance (rel-L2 <= 1e-2 per step), "
        "far below the cache's own effect",
        max(step_rel) <= 1e-2 and rel(s["video"], li["video"]) <= 0.05 * cache_effect,
        f"per-step max rel-L2 {[f'{x:.2e}' for x in step_rel]}; cache effect (lite vs exact) {cache_effect:.4f}",
    )
    # the attention itself: at every skip step and layer, the non-reference queries' output
    worst = 0.0
    for (layer, step), lc in li["caps"].items():
        if step == 0:
            continue
        sc = s["caps"][(layer, step)]
        keep = torch.cat([torch.arange(0, R0), torch.arange(R1, USED)])
        worst = max(worst, rel(sc["out"][:REDUCED_USED], lc["out"][keep]))
    chk(
        "(b) default kernels: every skip-step attention output of the non-reference rows matches stage 2-lite",
        worst <= 1e-2,
        f"max rel-L2 over {N_LAYERS} layers x {N_STEPS - 1} skip steps: {worst:.2e}",
    )

    # -- (c) the reference rows leave the block compute -----------------------------------------------------------
    s = res["skip_fp8"]
    by_step: dict[str, dict[int, set[int]]] = {
        kind: {t: {n for st, n in items if st == t} for t in range(N_STEPS)} for kind, items in s["rows"].items()
    }
    counts_ok = all(
        by_step[kind][t] == ({SEQ_LEN} if s["plan"][t] != "skip" else {REDUCED_SEQ})
        for kind in by_step
        for t in range(N_STEPS)
    ) and all(len([1 for st, _ in s["rows"]["block"] if st == t]) == N_LAYERS for t in range(N_STEPS))
    chk(
        "(c) skip steps run 64 rows (30 live + 34 padding) through every block, QKV, out_proj, fc1 and fc2 "
        "instead of 128; the fill step runs all 128",
        counts_ok,
        "; ".join(f"step {t} {s['plan'][t]}: {sorted(by_step['block'][t])}" for t in range(N_STEPS)),
    )
    calls = {t: sorted({(q, k) for st, q, k in s["attn_calls"] if st == t}) for t in range(N_STEPS)}
    chk(
        "(c) attention: fill step (88x88 live + 40x40 padding); skip steps 30 queries over 88 keys (+ 34x34 padding)",
        calls[0] == [(40, 40), (88, 88)] and all(calls[t] == [(30, 88), (34, 34)] for t in (1, 2, 3)),
        f"{calls}",
    )
    # FLOPs from the counted rows (tiny model) vs the session's analytic ratio (H3 sizes, same formula)
    p_block = HIDDEN * 3 * N_HEADS * HEAD_DIM + N_HEADS * HEAD_DIM * HIDDEN + HIDDEN * 2 * FFN + FFN * HIDDEN

    def counted(t: int) -> float:
        lin = 2.0 * p_block * sum(n for st, n in s["rows"]["block"] if st == t)
        att = 4.0 * N_HEADS * HEAD_DIM * sum(q * k for st, q, k in s["attn_calls"] if st == t)
        return lin + att

    ratio = counted(1) / counted(0)
    rep = s["report"]
    analytic = (2 * 385_351_680 * REDUCED_SEQ + 4 * REDUCED_SEQ * SEQ_LEN * 7168) / (
        2 * 385_351_680 * SEQ_LEN + 4 * SEQ_LEN * SEQ_LEN * 7168
    )
    chk(
        "(c) FLOPs: a skip step costs (M = N - R rows) / N of a fill step in linear work; the report uses that formula",
        0.4 < ratio < 0.6
        and abs(rep["analytic_flop"]["skipped_step_ratio"] - analytic) < 1e-6
        and rep["forwards"] == {"full": 0, "fill": 1, "skip": 3},
        f"counted tiny-model ratio {ratio:.3f}; report skipped_step_ratio {rep['analytic_flop']['skipped_step_ratio']}",
    )
    est = rules.cache_bytes(layers=N_LAYERS, ref_rows=R1 - R0, heads=N_HEADS, head_dim=HEAD_DIM, cache_dtype="fp8")
    chk(
        "(c) memory: cache bytes = layers x (K,V) x R x heads x head_dim x 1 B (+ per-head FP32 scales), as allocated",
        rep["cache_bytes_estimate"]
        == est
        == rep["cache_bytes_allocated"]
        == N_LAYERS * 2 * (58 * N_HEADS * HEAD_DIM + N_HEADS * 4)
        and res["skip_bf16_det"]["report"]["cache_bytes_allocated"] == N_LAYERS * 2 * 58 * N_HEADS * HEAD_DIM * 2,
        f"fp8 {est} B, bf16 {res['skip_bf16_det']['report']['cache_bytes_allocated']} B",
    )

    # -- (d) refresh steps and start_step -------------------------------------------------------------------------
    rr = res["skip_refresh_det"]
    blocks_rr = {t: sorted({n for st, n in rr["rows"]["block"] if st == t}) for t in range(N_STEPS)}

    def cache_equals_fill(r: dict[str, Any], seen_after: int, fill_step: int) -> bool:
        caps = r["caps"]
        return all(
            same(r["cache_seen"][seen_after][layer][0], fp8_roundtrip_ref(torch, caps[(layer, fill_step)]["k"][R0:R1]))
            and same(
                r["cache_seen"][seen_after][layer][1], fp8_roundtrip_ref(torch, caps[(layer, fill_step)]["v"][R0:R1])
            )
            for layer in range(N_LAYERS)
        )

    chk(
        "(d) refresh_steps [2]: plan fill, skip, fill, skip; step 2 runs every row again",
        rr["plan"] == plan_refresh and blocks_rr == {0: [SEQ_LEN], 1: [REDUCED_SEQ], 2: [SEQ_LEN], 3: [REDUCED_SEQ]},
        f"{rr['plan']} block rows {blocks_rr}",
    )
    last = N_LAYERS - 1
    chk(
        "(d) refresh_steps [2]: step 1 reads step 0's K/V (FP8 round trip), step 3 reads step 2's (refilled)",
        cache_equals_fill(rr, 0, 0)
        and cache_equals_fill(rr, 2, 2)
        and not same(rr["cache_seen"][2][last][0], rr["cache_seen"][0][last][0]),
    )
    sc = res["skip_refresh_det"]["caps"]
    chk(
        "(d) sanity: layer 0's reference K/V are exactly constant across full steps, deeper "
        "layers drift (the reference rows absorb the targets through attention)",
        same(sc[(0, 0)]["k"][R0:R1], sc[(0, 2)]["k"][R0:R1])
        and same(sc[(0, 0)]["v"][R0:R1], sc[(0, 2)]["v"][R0:R1])
        and not same(sc[(last, 0)]["k"][R0:R1], sc[(last, 2)]["k"][R0:R1]),
        f"layer {last} K drift step 0 -> 2: {rel(sc[(last, 2)]['k'][R0:R1], sc[(last, 0)]['k'][R0:R1]):.4f}",
    )
    r2 = res["skip_start2_det"]
    blocks_r2 = {t: sorted({n for st, n in r2["rows"]["block"] if st == t}) for t in range(N_STEPS)}
    chk(
        "(d) start_step 2: plan full, fill, skip, skip; the cache holds step 1's K/V (the last full step)",
        r2["plan"] == plan_start2
        and blocks_r2 == {0: [SEQ_LEN], 1: [SEQ_LEN], 2: [REDUCED_SEQ], 3: [REDUCED_SEQ]}
        and 0 not in r2["cache_seen"]
        and cache_equals_fill(r2, 1, 1),
        f"{r2['plan']} block rows {blocks_r2}",
    )
    chk(
        "(d) the plan function: refresh at the last step is a plain full step; start_step past the end skips nothing",
        rules.step_plan(4, start_step=1, refresh_steps=[3]) == ("fill", "skip", "skip", "full")
        and rules.step_plan(4, start_step=9) == ("full",) * 4,
        f"{rules.step_plan(4, start_step=1, refresh_steps=[3])}, {rules.step_plan(4, start_step=9)}",
    )

    # -- guards -----------------------------------------------------------------------------------------------------
    b = res["budget"]
    chk(
        "memory guard: max_cache_bytes below the estimate refuses before step 0 (no forward ran)",
        b["error"] is not None
        and b["error"].startswith("REF_KV_CACHE_OVER_BUDGET")
        and not b["per_step"]
        and not b["rows"]["block"],
        b["error"][:160] if b["error"] else "",
    )
    bb = res["bad_backend"]
    chk(
        "a block bound to a backend outside TORCH_SDPA/FA refuses before step 0",
        bb["error"] is not None and bb["error"].startswith("REF_KV_CACHE_ATTENTION_UNSUPPORTED") and not bb["per_step"],
        bb["error"][:160] if bb["error"] else "",
    )
    chk(
        "the report carries the plan, rows, bytes and the pinned upstream sources it checked",
        set(rep["source_sha256"])
        == {
            "minimax_h3.py MiniMaxH3DiTModel.forward",
            "minimax_h3.py MiniMaxH3DiTModel._embed",
            "minimax_h3.py MiniMaxH3DiTBlock.forward",
            "minimax_h3.py MiniMaxH3MLP.forward",
            "minimax_h3.py MiniMaxH3Attention.forward",
            "minimax_h3.py _minimax_h3_attention_core_impl",
            "minimax_h3.py MiniMaxH3FinalLayer.forward",
            "sdpa.py SDPAImpl.forward",
            "sdpa.py SDPAImpl.forward_varlen",
        }
        and rep["plan"] == plan_1
        and rep["rows"]["reference"] == R1 - R0
        and rep["attention_backend"] == "TORCH_SDPA",
        json.dumps({k: rep[k] for k in ("plan", "rows", "cache_bytes_estimate", "kv_buffer_bytes")}),
    )

    # -- an FA-style backend: impl.forward returns [B, S, H, D] without a transpose --------------------------------
    from phasyn_h3.recipe.runtime.ref_kv_cache import _dense

    class FaLike:
        def forward(self, q: Any, k: Any, v: Any, _md: Any) -> Any:
            out = torch.nn.functional.scaled_dot_product_attention(
                q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
            )
            return out.transpose(1, 2).contiguous()

    gen = torch.Generator().manual_seed(3)
    q, k, v = (torch.randn(n, 4, 128, generator=gen) for n in (5, 9, 9))
    got = _dense(FaLike(), q, k, v)
    want = torch.nn.functional.scaled_dot_product_attention(q.transpose(0, 1), k.transpose(0, 1), v.transpose(0, 1))
    chk(
        "dense call with fewer queries than keys: [Sq, H, D] out of a [1, Sq, H, D] backend",
        torch.allclose(got, want.transpose(0, 1), atol=1e-6),
    )

    report = {
        "work": str(work),
        "checks": [{"name": n, "ok": o, "detail": d} for n, o, d in chk.rows],
        "workers": {n: {"rc": p["rc"], "wall_s": p["wall_s"]} for n, p in procs.items()},
    }
    (work / "report.json").write_text(json.dumps(report, indent=1))
    print(f"\n{len(chk.rows) - len(chk.failed)}/{len(chk.rows)} checks passed; report {work / 'report.json'}")
    return 0 if not chk.failed else 1


def fp8_roundtrip_ref(torch: Any, x: Any) -> Any:
    return fp8_roundtrip_bf16(torch, x)


if __name__ == "__main__":
    raise SystemExit(main())
