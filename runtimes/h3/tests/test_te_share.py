"""h3.conditioning 跨 variant 共用已載入的 TE（te_share）：證明規則、provider 選 manifest、第二個 variant 不再載入。

CPU、假 loader：模型樹是 tmp 裡的小檔（FL2VA／Ref2VA 兩個 variant 目錄，TE 以 hard link 或複本建立）；
「載入次數」用 recipe 的真實 ComponentRegistry／SGLangH3Provider.use_component，只把 SGLang loader 換成計數的假 loader。
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from phasyn_h3 import te_share
from phasyn_h3.config import build_profile, default_settings
from phasyn_h3.plan import model_manifest

FILES: dict[str, dict[str, bytes]] = {
    "text_encoder": {
        "config.json": b'{"architectures": ["MiniMaxH3Qwen3VLHFEncoder"], "hidden_size": 5120}',
        "model-00001-of-00002.safetensors": b"\x01" * 4096,
        "model-00002-of-00002.safetensors": b"\x02" * 2048,
        "model.safetensors.index.json": b'{"metadata": {"total_size": 6144}}',
    },
    "tokenizer": {"tokenizer.json": b'{"vocab": 1}', "vocab.json": b"{}"},
    "processor": {"preprocessor_config.json": b'{"merge_size": 2}', "tokenizer.json": b'{"vocab": 1}'},
}
INDEX = {
    "_class_name": "MiniMaxH3Pipeline",
    "text_encoder": ["transformers", "MiniMaxH3Qwen3VLHFEncoder"],
    "tokenizer": ["transformers", "Qwen2TokenizerFast"],
    "processor": ["transformers", "Qwen3VLProcessor"],
    "transformer": ["diffusers", "MiniMaxH3DiTModel"],
}
DIRS = {"fl2va": "FL2VA", "ref2va": "Ref2VA"}


def _tree(root: Path, *, link_te: bool = True, overrides: dict[str, bytes] | None = None) -> Path:
    """一個常見的模型資料夾樣子：Ref2VA/text_encoder 是 FL2VA 的 hard link，tokenizer／processor 是內容相同的複本；
    兩邊 model_index.json 只差 _minimax_h3 的 partition／tasks。``overrides``：Ref2VA 這邊改寫的檔（kind/name）。"""
    base = root / "MiniMax-H3"
    for variant, name in DIRS.items():
        index = {
            **INDEX,
            "_minimax_h3": {"partition": variant, "tasks": ["ref2va"] if variant == "ref2va" else ["t2va", "fl2va"]},
        }
        (base / name).mkdir(parents=True, exist_ok=True)
        (base / name / "model_index.json").write_text(json.dumps(index), encoding="utf-8")
        (base / name / "transformer").mkdir(exist_ok=True)
    for kind, files in FILES.items():
        for name, data in files.items():
            src = base / "FL2VA" / kind / name
            dst = base / "Ref2VA" / kind / name
            src.parent.mkdir(parents=True, exist_ok=True)
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.write_bytes(data)
            if kind == "text_encoder" and link_te:
                os.link(src, dst)
            else:
                dst.write_bytes(data)
    for rel, data in (overrides or {}).items():
        target = base / "Ref2VA" / rel
        if target.exists():
            target.unlink()  # 不寫穿 hard link
        target.write_bytes(data)
    return root


# ---------------------------------------------------------------- 逐檔證明（純函式）


def test_digest_cache_reuses_large_file_digest_and_notices_rewrites(tmp_path: Path) -> None:
    shard = tmp_path / "shard.safetensors"
    shard.write_bytes(b"\x05" * 1024)
    cache_dir = tmp_path / "digests"
    first = te_share.DigestCache(cache_dir, min_bytes=512)
    value = first(shard)
    assert value == hashlib.sha256(b"\x05" * 1024).hexdigest() and first.computed_files == 1
    second = te_share.DigestCache(cache_dir, min_bytes=512)
    assert second(shard) == value and second.cache_hits == 1 and second.computed_files == 0
    st = shard.stat()
    # 同大小覆寫、再把 mtime 改回去：ctime 仍會變。檔案時間戳是粗粒度時鐘，同一個 tick 內的覆寫看不出來，所以重寫到 ctime 變為止
    for _ in range(400):
        shard.write_bytes(b"\x06" * 1024)
        os.utime(shard, ns=(st.st_atime_ns, st.st_mtime_ns))
        if shard.stat().st_ctime_ns != st.st_ctime_ns:
            break
        time.sleep(0.005)
    assert shard.stat().st_mtime_ns == st.st_mtime_ns and shard.stat().st_ctime_ns != st.st_ctime_ns
    third = te_share.DigestCache(cache_dir, min_bytes=512)
    assert third(shard) == hashlib.sha256(b"\x06" * 1024).hexdigest() and third.computed_files == 1
    small = te_share.DigestCache(cache_dir, min_bytes=4096)
    small(shard)
    assert small.computed_files == 1 and len(list(cache_dir.iterdir())) == 2  # 小檔不寫快取


# ---------------------------------------------------------------- 判斷（te-uma0 的設定）


def _settings(tmp_path: Path) -> dict[str, Any]:
    settings = default_settings("conditioning", model_path=str(tmp_path), device_id="GPU-x")
    settings["load"]["provider_options"] = {"variant": "fl2va", "shared_from": "ref2va", "mode": "exact"}
    return settings


def _manifest(root: Path, variant: str, shared_from: str, model_id: str | None = None) -> dict[str, Any]:
    return model_manifest(
        variant=variant,
        shared_from=shared_from,
        transformer_file=None,
        model_root=root,
        cache_dir=root / "cache",
        model_id=model_id,
    )


def _manifests(root: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    loaded = _manifest(root, "fl2va", "ref2va")  # te-uma0：variant=fl2va、shared_from=ref2va
    shared = _manifest(root, "ref2va", "ref2va", str(loaded["model_id"]))  # 沿用已載入的身分
    separate = _manifest(root, "ref2va", "fl2va")  # 以前的做法（另一個 model_id）
    return loaded, shared, separate


def _decide(root: Path, **overrides: Any) -> te_share.ShareDecision:
    loaded, shared, separate = _manifests(root)
    settings = te_share.settings_fingerprint(build_profile("conditioning", _settings(root), profile_id="t", revision=1))
    kwargs: dict[str, Any] = {
        "variant": "ref2va",
        "own_variant": "fl2va",
        "loaded": loaded,
        "shared": shared,
        "separate": separate,
        "model_root": root,
        "loaded_settings": settings,
        "variant_settings": settings,
        "digest": te_share.DigestCache(root / "cache"),
    }
    kwargs.update(overrides)
    return te_share.decide(**kwargs)


def test_decide_shares_for_hardlinks_and_identical_sha(tmp_path: Path) -> None:
    linked = _decide(_tree(tmp_path / "linked"))
    assert linked.applied, linked.reason
    assert linked.methods() == {"text_encoder": "inode", "tokenizer": "sha256", "processor": "sha256"}
    assert linked.model_index["identical"] and linked.settings["identical"]
    fact = linked.fact()
    assert fact["proof"]["text_encoder"]["loaded"] == "MiniMax-H3/Ref2VA/text_encoder"  # relative to the model root
    assert fact["proof"]["text_encoder"]["other"] == "MiniMax-H3/FL2VA/text_encoder"
    assert fact["model_index"]["loaded"] == "MiniMax-H3/Ref2VA/model_index.json"
    assert str(tmp_path) not in json.dumps(fact, ensure_ascii=False)  # the load record never names local folders
    assert fact["manifests"]["shared"] == fact["manifests"]["loaded"]
    assert fact["manifests"]["separate"]["model_id"] == "h3-ref2va-local"
    copied = _decide(_tree(tmp_path / "copied", link_te=False))
    assert copied.applied and copied.methods()["text_encoder"] == "sha256"
    assert copied.hashing["computed_files"] == 2 * 8  # 兩邊各 8 個檔都讀過一次（小檔不快取）


def test_decide_keeps_separate_copies_when_config_differs(tmp_path: Path) -> None:
    root = _tree(tmp_path, link_te=False, overrides={"text_encoder/config.json": b'{"hidden_size": 4096}'})
    decision = _decide(root)
    assert not decision.applied and "config.json" in decision.reason
    assert str(tmp_path) not in json.dumps(decision.fact(), ensure_ascii=False)
    assert decision.fact()["proof"]["text_encoder"]["identical"] is False


# ---------------------------------------------------------------- provider：同一份 registry 只載入一次
