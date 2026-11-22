"""CPU test of Normalized Attention Guidance on the H3 DiT (``nag_conditioning`` + ``nag_*`` on ``h3.dit``).

GPU-free by construction (``CUDA_VISIBLE_DEVICES=""``, SGLang's CPU platform, NVML blocked); nothing is downloaded
and nothing is written outside ``--work``. It runs the real pinned SGLang H3 code of a GPU runtime tuple's
environment with this checkout's ``phasyn_h3`` first on ``sys.path``: Phasyn's ``build_packed`` (Ref2VA layout),
SGLang's ``MiniMaxH3DenoiseBranch``, ``minimax_h3_denoise_loop`` and a tiny randomly initialised
``MiniMaxH3DiTModel`` (4 blocks, 4 heads x 128) on the torch-SDPA backend (what ``auto_exact`` resolves to), driven
the way ``stages/denoise_av`` drives it.

Checks
  (a) off / phi = 0: a session with phi = 0 runs the extended sequence and returns the baseline (the negative rows
      never reach a positive row); after any session every block has its original attention impl and the class
      ``_embed`` back, and a plain loop is bit-identical to the first baseline;
  (b) phi = 4: at every layer of every NAG step the attention output equals an independent reimplementation
      (positive segment, negative segment, padding segment with torch SDPA, the paper's formula in FP64 on the
      target video rows, written out here the official way: ``nag_scale = phi + 1``, clip where ratio > tau);
      the latents differ from the baseline and are finite;
  (c) the extended layout: negative text rows at [used, used + Ln), their block-0 input equals the refined negative
      embedding, their RoPE rows equal the last Ln positive text rows, their AdaLN indices equal a positive text
      row's, the unique timesteps and the AdaLN slot are the loop's;
  (d) nag_steps = 1 runs one NAG forward and plain forwards after it; a hybrid/sparse backend is refused.

usage: CUDA_VISIBLE_DEVICES= <runtime>/bin/python -I -B runtimes/h3/tests/nag_cpu.py [--work DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for _path in (
    REPO / "packages/media/src",
    REPO / "packages/components/src",
    REPO / "runtimes/h3/src",
):
    sys.path.insert(0, str(_path))

TEXT_LEN = 12
QWEN_TEXT_ROWS = (3, 4, 5, 6)
NEG_LEN = 5
REF_BLOCKS = [
    {"kind": "image", "latent_h": 4, "latent_w": 4},
    {
        "kind": "video_audio",
        "ref_audio_t": 3,
        "latent_t": 3,
        "latent_h": 8,
        "latent_w": 8,
    },
]
LATENT = {"latent_t": 3, "latent_h": 4, "latent_w": 4, "audio_t": 3}
SIGMAS = [1.0, 0.92, 0.8, 0.6, 0.35]
N_LAYERS, N_HEADS, HEAD_DIM, HIDDEN, FFN = 4, 4, 128, 256, 512
N_STEPS = len(SIGMAS) - 1


def main() -> int:  # noqa: C901, PLR0915 - The scientific parity run compares distinct named arms with shared model state.
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", default=None)
    args = parser.parse_args()
    work = Path(args.work or tempfile.mkdtemp(prefix="nag-cpu-"))
    work.mkdir(parents=True, exist_ok=True)
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
    from sglang.multimodal_gen.third_party import pynvml as _nv  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.

    def _blocked(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("NVML blocked by nag_cpu (CPU only)")

    _nv.nvmlInit = _blocked
    real_cap = torch.cuda.get_device_capability
    torch.cuda.get_device_capability = lambda *_args, **_kwargs: (0, 0)
    try:
        from sglang.multimodal_gen.runtime.models.dits import minimax_h3 as mh  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
    finally:
        torch.cuda.get_device_capability = real_cap
    from sglang.multimodal_gen.configs.models.dits.minimax_h3 import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        MiniMaxH3DiTArchConfig,
        MiniMaxH3DiTConfig,
    )
    from sglang.multimodal_gen.runtime.distributed.parallel_state import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        maybe_init_distributed_environment_and_model_parallel,
    )
    from sglang.multimodal_gen.runtime.layers.attention.backends.sdpa import SDPABackend  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
    from sglang.multimodal_gen.runtime.managers.forward_context import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        set_forward_context,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3 import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        denoise_loop as dl,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.denoising import (  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.
        _precompute_refined_prompt_embeds,
        _precompute_rope_cache,
    )
    from sglang.multimodal_gen.runtime.platforms import AttentionBackendEnum  # type: ignore[import-untyped]  # Pinned SGLang has no PEP 561 metadata.

    from phasyn_h3.recipe.runtime import nag as nag_mod, nag_rules as rules  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.
    from phasyn_h3.recipe.runtime.errors import UnsupportedCombination  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.
    from phasyn_h3.recipe.runtime.stages.layout import LatentDims, build_packed, tagged  # noqa: PLC0415 - Keep this optional experiment dependency behind its runtime check.

    maybe_init_distributed_environment_and_model_parallel(
        tp_size=1,
        sp_size=1,
        cfg_degree=1,
        ulysses_degree=1,
        ring_degree=1,
        dp_size=1,
        distributed_init_method=f"file://{work}/rdv-{os.getpid()}",
    )
    failures: list[str] = []

    def check(ok: bool, what: str) -> None:  # noqa: FBT001 - Keep the assertion value next to the outcome it describes.
        print(("ok   " if ok else "FAIL ") + what, flush=True)  # noqa: T201 - The standalone verification command reports results on stdout.
        if not ok:
            failures.append(what)

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
        model.rope.inv_freq.copy_(
            10000.0 ** (-torch.arange(0, 32, 2, dtype=torch.float32) / 32)
        )
    model.eval()
    for m in model.modules():
        if isinstance(m, mh.MiniMaxH3Attention):
            m._set_attention_backend(SDPABackend)
    model._resolved_attention_backend = AttentionBackendEnum.TORCH_SDPA
    original_impls = [blk.attn._attention_impl for blk in model.blocks]

    blocks = {
        "keyframes": [],
        "ref2va_blocks": REF_BLOCKS,
        "visual_tensors": [],
        "audio_tensors": [],
    }
    packed = build_packed("ref2va", TEXT_LEN, LatentDims(**LATENT), blocks, 0)
    text_tags = torch.ones(TEXT_LEN, dtype=torch.long)
    text_tags[list(QWEN_TEXT_ROWS)] = 0
    tags = tagged(packed, text_tags)
    gen = torch.Generator().manual_seed(1)
    emb = torch.randn(TEXT_LEN, 64, generator=gen).to(torch.bfloat16)
    neg_hidden = torch.randn(NEG_LEN, 64, generator=gen).to(torch.bfloat16)
    neg_tags = torch.ones(NEG_LEN, dtype=torch.long)
    dev = torch.device("cpu")

    def new_branch() -> Any:
        pos = dl.MiniMaxH3DenoiseBranch(
            packed=packed, text_embeddings=emb, token_tags=tags, device=dev
        )
        _precompute_refined_prompt_embeds(
            model, pos, device=dev, shared_conditioning=None
        )
        _precompute_rope_cache(model, pos, device=dev)
        return pos

    pos0 = new_branch()
    init_v = torch.randn(int(pos0.img_pos.shape[0]), 96, generator=gen)
    init_a = torch.randn(int(pos0.audio_pos.shape[0]), 32, generator=gen)
    cond = torch.randn(int((~pos0.update_mask).sum()), 96, generator=gen)
    aref = torch.randn(int((~pos0.audio_update_mask).sum()), 32, generator=gen)

    def forward(model_: Any, kwargs: dict[str, Any], step: int) -> Any:
        with set_forward_context(current_timestep=step, attn_metadata=None):
            return model_(**kwargs)

    def loop(branch: Any, model_forward: Any) -> tuple[Any, Any]:
        with torch.inference_mode():
            video, audio = dl.minimax_h3_denoise_loop(
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
                on_step=None,
            )
            return video, audio

    def session(branch: Any, nag: Any) -> Any:
        return nag_mod.NagSession(
            model,
            branch,
            nag,
            negative_hidden=neg_hidden,
            negative_tags=neg_tags,
            positive_text_tags=text_tags,
            steps=N_STEPS,
            device=dev,
        )

    def restored() -> bool:
        return all(
            blk.attn._attention_impl is impl
            for blk, impl in zip(model.blocks, original_impls, strict=True)
        ) and ("_embed" not in vars(model))

    base_v, base_a = loop(new_branch(), forward)
    check(
        bool(torch.isfinite(base_v).all() and torch.isfinite(base_a).all()),
        "baseline finite",
    )

    # (a) phi = 0 runs the extended sequence and gives the baseline
    pos = new_branch()
    s0 = session(pos, rules.Nag(phi=0.0, tau=2.5, alpha=0.25))
    with s0.active():
        v0, a0 = loop(pos, s0.wrap_forward(forward))
    dv = float((v0.float() - base_v.float()).abs().max())
    da = float((a0.float() - base_a.float()).abs().max())
    print(f"     phi=0 vs baseline: max |dv| {dv:.3e}, |da| {da:.3e}")  # noqa: T201 - The standalone verification command reports results on stdout.
    check(
        s0.counts == {"nag": N_STEPS, "plain": 0},
        f"phi=0 ran {N_STEPS} NAG forwards ({s0.counts})",
    )
    check(
        dv <= 2e-2 and da <= 2e-2,
        "phi=0 equals the baseline (bf16 GEMM row-count tolerance)",
    )
    check(restored(), "impls and _embed restored after the phi=0 session")

    # (b) + (c) phi = 4: every layer's attention output against an independent reimplementation
    caps: list[dict[str, Any]] = []
    block0_inputs: list[Any] = []
    real_core = mh._minimax_h3_attention_core_impl

    def capture(attention: Any, q: Any, k: Any, v: Any, **kw: Any) -> Any:
        ins = (q.detach().clone(), k.detach().clone(), v.detach().clone())
        out = real_core(attention, q, k, v, **kw)
        caps.append(
            {
                "q": ins[0],
                "k": ins[1],
                "v": ins[2],
                "out": out.detach().clone(),
                "rows": int(q.shape[0]),
            }
        )
        return out

    pos = new_branch()
    nag = rules.Nag(phi=4.0, tau=2.5, alpha=0.25)
    s4 = session(pos, nag)  # before the probes: its pin check must see the real sources
    hook = model.blocks[0].register_forward_pre_hook(
        lambda _m, a: block0_inputs.append(a[0].detach().clone())
    )
    mh._minimax_h3_attention_core_impl = capture
    mh._minimax_h3_attention_core_bcg = mh.eager_on_graph(True)(capture)  # noqa: FBT003 - Use the pinned upstream positional switch.
    rm = s4.rows
    kwargs_seen: list[dict[str, Any]] = []

    def spy(model_: Any, kwargs: dict[str, Any], step: int) -> Any:
        kwargs_seen.append(dict(kwargs))
        return forward(model_, kwargs, step)

    loop_kwargs: list[dict[str, Any]] = []

    def outer(model_: Any, kwargs: dict[str, Any], step: int) -> Any:
        loop_kwargs.append(dict(kwargs))
        return s4.wrap_forward(spy)(model_, kwargs, step)

    with s4.active():
        v4, a4 = loop(pos, outer)
    hook.remove()
    mh._minimax_h3_attention_core_impl = real_core
    mh._minimax_h3_attention_core_bcg = mh.eager_on_graph(True)(real_core)  # noqa: FBT003 - Use the pinned upstream positional switch.
    check(restored(), "impls and _embed restored after the phi=4 session")
    check(
        bool(torch.isfinite(v4).all() and torch.isfinite(a4).all()),
        "phi=4 latents finite",
    )
    check(
        float((v4.float() - base_v.float()).abs().max()) > 1e-3,
        "phi=4 changes the video latent",
    )
    check(
        len(caps) == N_LAYERS * N_STEPS,
        f"{len(caps)} attention calls ({N_LAYERS} x {N_STEPS})",
    )
    check(
        all(c["rows"] == rm.ext_seq_len for c in caps),
        f"every NAG call has {rm.ext_seq_len} rows",
    )

    scale = 1.0 / (HEAD_DIM**0.5)

    def sdpa(q: Any, k: Any, v: Any) -> Any:  # FP64 dense attention, [S, H, D]
        q, k, v = (t.double().transpose(0, 1) for t in (q, k, v))
        w = torch.softmax((q @ k.transpose(-1, -2)) * scale, dim=-1)
        return (w @ v).transpose(0, 1)

    guided = pos.img_target_seq_idx.view(-1).long()
    worst = 0.0
    for c in caps:
        q, k, v = c["q"], c["k"], c["v"]
        zp = sdpa(q[: rm.used], k[: rm.used], v[: rm.used])
        zn = sdpa(
            q[rm.text_len : rm.ext_used],
            k[rm.text_len : rm.ext_used],
            v[rm.text_len : rm.ext_used],
        )
        exp = torch.zeros_like(c["out"], dtype=torch.float64)
        exp[: rm.used] = zp
        exp[rm.used : rm.ext_used] = zn[rm.used - rm.text_len :]
        if rm.ext_seq_len > rm.ext_used:
            exp[rm.ext_used :] = sdpa(
                q[rm.ext_used :], k[rm.ext_used :], v[rm.ext_used :]
            )
        # the official processor, written out: nag_scale = phi + 1, L1 over the inner dim, clip where ratio > tau
        p = zp[guided].reshape(len(guided), -1)
        n = zn[guided - rm.text_len].reshape(len(guided), -1)
        s = nag.phi + 1.0
        g = p * s - n * (s - 1.0)
        pn = p.abs().sum(-1, keepdim=True)
        gn = g.abs().sum(-1, keepdim=True)
        ratio = torch.nan_to_num(gn / pn, nan=10.0)
        mask = (ratio > nag.tau).expand_as(g)
        g = torch.where(mask, g / (gn + 1e-7) * pn * nag.tau, g)
        exp[guided] = (g * nag.alpha + p * (1.0 - nag.alpha)).reshape(
            len(guided), N_HEADS, HEAD_DIM
        )
        worst = max(
            worst,
            float((c["out"].double() - exp).abs().max() / (exp.abs().max() + 1e-12)),
        )
    print(f"     worst relative error vs the independent NAG: {worst:.3e}")  # noqa: T201 - The standalone verification command reports results on stdout.
    check(worst < 2e-2, "attention output == independent NAG (bf16 tolerance)")

    neg_rows = slice(rm.used, rm.ext_used)
    check(
        rm.neg_len == NEG_LEN and rm.negative_text == (rm.used, rm.used + NEG_LEN),
        "negative rows after used",
    )
    check(
        all(
            torch.equal(b[neg_rows], s4.negative_embed.to(b.dtype))
            for b in block0_inputs
        ),
        "block-0 input of the negative rows == refined negative text",
    )
    rope_cos = s4._static["rope_cache"][0]
    pos_cos = pos.static_kwargs["rope_cache"][0]
    check(
        torch.equal(rope_cos[neg_rows], pos_cos[TEXT_LEN - NEG_LEN : TEXT_LEN]),
        "negative RoPE rows == last Ln positive text rows (right aligned)",
    )
    check(
        torch.equal(rope_cos[: rm.used], pos_cos[: rm.used]),
        "positive RoPE rows unchanged",
    )
    text_row = next(i for i in range(TEXT_LEN) if i not in QWEN_TEXT_ROWS)
    ok_idx = True
    for outer_kw, inner_kw in zip(loop_kwargs, kwargs_seen, strict=True):
        ok_idx &= inner_kw["unique_timesteps"] is outer_kw["unique_timesteps"]
        inv, ext_inv = outer_kw["inverse_indices"], inner_kw["inverse_indices"]
        ok_idx &= bool(torch.equal(ext_inv[: rm.used], inv[: rm.used]))
        ok_idx &= bool((ext_inv[neg_rows] == inv[text_row]).all())
        if outer_kw.get("block_combined_indices") is not None:
            comb = inner_kw["block_combined_indices"]
            ok_idx &= bool(
                (comb[neg_rows] == outer_kw["block_combined_indices"][text_row]).all()
            )
        if "adaln_cache_slot" in outer_kw:
            ok_idx &= inner_kw["adaln_cache_slot"] is outer_kw["adaln_cache_slot"]
    check(
        ok_idx,
        "negative rows take a text row's AdaLN indices; timesteps / slot are the loop's",
    )
    check(
        bool((s4._static["block_token_tags"][neg_rows] == 1).all()),
        "negative rows are tagged as text (block tags)",
    )

    # (d) nag_steps = 1, then a plain loop is the baseline bit for bit; a sparse backend is refused
    pos = new_branch()
    s1 = session(pos, rules.Nag(phi=4.0, tau=2.5, alpha=0.25, steps=1))
    with s1.active():
        loop(pos, s1.wrap_forward(forward))
    check(s1.counts == {"nag": 1, "plain": N_STEPS - 1}, f"nag_steps=1 ran {s1.counts}")
    v_off, a_off = loop(new_branch(), forward)
    check(
        torch.equal(v_off, base_v) and torch.equal(a_off, base_a),
        "plain loop after sessions == baseline (bit)",
    )
    report = s4.report()
    check(
        report["forwards"] == {"nag": N_STEPS, "plain": 0} and report["phi"] == 4.0,
        "report facts",
    )
    json.dumps(report)  # serialisable into the payload metadata

    model.blocks[
        1
    ].attn._attention_backend_enum = AttentionBackendEnum.SUBBLOCK_SPARSE_ATTN
    try:
        session(new_branch(), nag)
        check(ok=False, what="a SubBlock-sparse block is refused")
    except UnsupportedCombination as exc:
        check(
            exc.reason_code == "NAG_ATTENTION_UNSUPPORTED",
            f"a SubBlock-sparse block is refused ({exc.reason_code})",
        )
    model.blocks[1].attn._attention_backend_enum = AttentionBackendEnum.TORCH_SDPA

    print(f"{'PASS' if not failures else 'FAIL'}: {len(failures)} failure(s)")  # noqa: T201 - The standalone verification command reports results on stdout.
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
