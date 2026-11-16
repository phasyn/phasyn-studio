"""NF4 單檔 DiT 的 SGLang overlay：model_index 列出的其他元件要存在（連結到完整 snapshot），只載入 transformer。"""

from __future__ import annotations

from pathlib import Path

from phasyn_h3.recipe.runtime.checkpoint_inspect import write_overlay


def test_overlay_links_sibling_components_and_keeps_transformer_local(tmp_path: Path) -> None:
    variant_dir = tmp_path / "MiniMax-H3" / "Ref2VA"
    for name in ("audio_vae", "video_vae", "text_encoder", "tokenizer", "processor"):
        (variant_dir / name).mkdir(parents=True)
    weights = tmp_path / "nf4.safetensors"
    weights.write_bytes(b"x")
    model_index = {
        "_class_name": "MiniMaxH3Pipeline",
        "_diffusers_version": "0.36.0",
        "transformer": ["diffusers", "MiniMaxH3DiTModel"],
        "audio_vae": ["diffusers", "X"],
        "video_vae": ["diffusers", "X"],
        "text_encoder": ["transformers", "X"],
        "tokenizer": ["transformers", "X"],
        "processor": ["transformers", "X"],
        "scheduler": "not-a-component-pair",
    }
    overlay = tmp_path / "overlay"
    transformer_dir = write_overlay(
        overlay, weights_file=weights, config={"a": 1}, model_index=model_index, component_root=variant_dir
    )
    assert (transformer_dir / "config.json").is_file()
    for name in ("audio_vae", "video_vae", "text_encoder", "tokenizer", "processor"):
        assert (overlay / name).is_symlink() and (overlay / name).resolve() == (variant_dir / name).resolve()
    assert not (overlay / "transformer").is_symlink()
    # 再寫一次（重新載入）不會失敗、也不會改掉既有連結
    write_overlay(overlay, weights_file=weights, config={"a": 1}, model_index=model_index, component_root=variant_dir)
    assert (overlay / "audio_vae").is_symlink()
