"""從我們自己產生的 (final latent, 解碼影像) 配對，以最小平方擬合 ``linear_fit`` 預覽係數（64→3 矩陣+bias）.

只用我們自己的輸出（不使用任何第三方係數）。手動執行的維護工具；不寫入任何服務、不送 POST。

輸入（兩種，可混用）：
  --pair LATENT.safetensors IMAGE.png   qimg.dit 輸出 bundle 的 payload（含 ``latent`` (1,H·W,C) BF16）與對應的
                                        qimg.vae_decode PNG（同一張；尺寸必須是 16H×16W）
  --run RUN_ID --controller URL --data-dir NODE_DATA_DIR
                                        以 GET 讀 run（/api/runs/{id}），找出每個 qimg.latent.v1 輸出與吃它的 decode
                                        步驟的 PNG，從本機 Node 檔案庫 <data-dir>/files/<file_id>/payload 讀檔（驗 SHA-256）
輸出：--output 係數 JSON（schema phasyn_qimg.preview_linear_fit.v1；已存在時需 --force 才覆寫）。

擬合目標：影像先以白底合成 alpha（與預覽顯示一致），再以 16×16 區塊平均降到 latent 格點，RGB 縮放到 [0,1]；
解 [X 1]·β = Y（X=latent 每 token 的 C 維；可選 --ridge 只對矩陣部分加 L2）。報告每 channel RMSE／R²。
torch-free：只需要 numpy 與 Pillow（自帶最小 safetensors 讀取器，BF16 以位元轉 FP32）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, Any

import numpy as np


_PACKED_RANK = 3

_SAFETENSOR_LENGTH_BYTES = 8

SCHEMA = "phasyn_qimg.preview_linear_fit.v1"
SOURCE = "phasyn_qimg.fit_preview_coefficients"
LATENT_SPACE = "qwen-image-2.1.vae-normalized"
LATENT_TYPE = "qimg.latent.v1"
VAE_SCALE = 16
DTYPES = {"F32": np.float32, "F16": np.float16, "F64": np.float64}


# ---------------------------------------------------------------------------------------------- 讀檔
def read_safetensors(data: bytes) -> dict[str, np.ndarray]:
    """最小 safetensors 讀取器（F32／F16／F64／BF16；BF16 以高 16 位元展開成 FP32，數值無損）."""
    if len(data) < _SAFETENSOR_LENGTH_BYTES:
        raise ValueError("safetensors 太短")
    (header_len,) = struct.unpack("<Q", data[:8])
    header = json.loads(data[8 : 8 + header_len])
    base = 8 + header_len
    out: dict[str, np.ndarray] = {}
    for name, spec in header.items():
        if name == "__metadata__":
            continue
        start, end = spec["data_offsets"]
        raw = data[base + start : base + end]
        shape = [int(x) for x in spec["shape"]]
        dtype = spec["dtype"]
        if dtype == "BF16":
            bits = np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16
            array = bits.view(np.float32)
        elif dtype in DTYPES:
            array = np.frombuffer(
                raw, dtype=np.dtype(DTYPES[dtype]).newbyteorder("<")
            ).astype(np.float32)
        else:
            raise ValueError(f"不支援的 dtype {dtype}（{name}）")
        out[name] = array.reshape(shape)
    return out


def image_targets(png: bytes, *, latent_h: int, latent_w: int) -> np.ndarray:
    """PNG → 白底合成 → [0,1] RGB → 16×16 區塊平均到 (H·W, 3)."""
    import io  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.

    from PIL import Image

    image: Image.Image = Image.open(io.BytesIO(png))
    image.load()
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        white = Image.new("RGB", image.size, (255, 255, 255))
        white.paste(image, mask=image.getchannel("A"))
        image = white
    elif image.mode != "RGB":
        image = image.convert("RGB")
    width, height = image.size
    if (width, height) != (latent_w * VAE_SCALE, latent_h * VAE_SCALE):
        raise ValueError(
            f"影像 {width}×{height} 與 latent 格點 {latent_w}×{latent_h}（×16）不符"
        )
    rgb = np.asarray(image, dtype=np.float64) / 255.0
    blocks = rgb.reshape(latent_h, VAE_SCALE, latent_w, VAE_SCALE, 3).mean(axis=(1, 3))
    return blocks.reshape(latent_h * latent_w, 3)


@dataclass
class Pair:
    """Decoded image targets paired with their originating latents."""

    latent: np.ndarray  # (N, C) float64
    target: np.ndarray  # (N, 3)
    provenance: dict[str, Any]


def pair_from_bytes(
    latent_bytes: bytes, png_bytes: bytes, *, provenance: Mapping[str, Any]
) -> Pair:
    """Build a training pair from latent and image bytes."""
    tensors = read_safetensors(latent_bytes)
    if "latent" not in tensors:
        raise ValueError("latent payload 沒有 'latent' tensor")
    latent = tensors["latent"]
    if latent.ndim != _PACKED_RANK or latent.shape[0] != 1:
        raise ValueError(f"latent 必須是 (1, H·W, C)，收到 {list(latent.shape)}")
    import io  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.

    from PIL import Image

    with Image.open(io.BytesIO(png_bytes)) as probe:
        width, height = probe.size
    latent_h, latent_w = height // VAE_SCALE, width // VAE_SCALE
    if latent_h * latent_w != latent.shape[1]:
        raise ValueError(
            f"latent token 數 {latent.shape[1]} 與影像 {width}×{height} 不符"
        )
    target = image_targets(png_bytes, latent_h=latent_h, latent_w=latent_w)
    info = {
        **dict(provenance),
        "latent_sha256": hashlib.sha256(latent_bytes).hexdigest(),
        "image_sha256": hashlib.sha256(png_bytes).hexdigest(),
        "width": width,
        "height": height,
        "tokens": int(latent.shape[1]),
    }
    return Pair(latent=latent[0].astype(np.float64), target=target, provenance=info)


# ---------------------------------------------------------------------------------------------- 擬合
def fit(pairs: Iterable[Pair], *, ridge: float = 0.0) -> dict[str, Any]:
    """[X 1]·β = Y 的正規方程式（累加，不保留全部樣本）；ridge 只加在矩陣部分（bias 不懲罰）."""
    xtx: np.ndarray | None = None
    xty: np.ndarray | None = None
    count = 0
    channels = 0
    for pair in pairs:
        x = np.concatenate([pair.latent, np.ones((pair.latent.shape[0], 1))], axis=1)
        channels = pair.latent.shape[1]
        if xtx is None:
            xtx = np.zeros((x.shape[1], x.shape[1]))
            xty = np.zeros((x.shape[1], 3))
        elif xtx.shape[0] != x.shape[1]:
            raise ValueError("配對之間的 latent channel 數不同")
        if xty is None:
            raise AssertionError
        xtx += x.T @ x
        xty += x.T @ pair.target
        count += x.shape[0]
    if xtx is None or xty is None or count <= channels + 1:
        raise ValueError(f"樣本不足：{count} 個 latent token，至少需要 {channels + 2}")
    reg = np.eye(xtx.shape[0]) * ridge
    reg[-1, -1] = 0.0
    beta = np.linalg.solve(xtx + reg, xty)
    return {"beta": beta, "samples": count, "channels": channels}


def evaluate(beta: np.ndarray, pairs: Iterable[Pair]) -> dict[str, Any]:
    """Measure the fit on the supplied held-out pairs."""
    sse = np.zeros(3)
    total = np.zeros(3)
    sums = np.zeros(3)
    sq = np.zeros(3)
    n = 0
    for pair in pairs:
        x = np.concatenate([pair.latent, np.ones((pair.latent.shape[0], 1))], axis=1)
        pred = np.clip(x @ beta, 0.0, 1.0)
        err = pred - pair.target
        sse += (err**2).sum(axis=0)
        sums += pair.target.sum(axis=0)
        sq += (pair.target**2).sum(axis=0)
        n += pair.target.shape[0]
    mean = sums / max(n, 1)
    total = sq - n * mean**2
    rmse = np.sqrt(sse / max(n, 1))
    r2 = [float(1 - s / t) if t > 0 else None for s, t in zip(sse, total, strict=True)]
    return {"rmse_rgb01": [float(v) for v in rmse], "r2": r2, "samples": n}


def build_document(
    beta: np.ndarray, *, stats: Mapping[str, Any], pairs: list[Pair], ridge: float
) -> dict[str, Any]:
    """Build a versioned coefficient document from fitted weights and evaluation results."""
    channels = beta.shape[0] - 1
    return {
        "schema": SCHEMA,
        "latent_space": LATENT_SPACE,
        "channels": channels,
        "target": "rgb01_white_matte（PNG alpha 先合成白底，16×16 區塊平均）",
        "matrix": [[float(v) for v in row] for row in beta[:-1]],
        "bias": [float(v) for v in beta[-1]],
        "fit": {
            **dict(stats),
            "pairs": len(pairs),
            "ridge": ridge,
            "method": "least_squares_normal_equations",
            "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tool": "runtimes/qimg/tools/fit_preview_coefficients.py",
        },
        "provenance": {
            "source": SOURCE,
            "synthetic": any(bool(p.provenance.get("synthetic")) for p in pairs),
            "pairs": [p.provenance for p in pairs],
        },
    }


# ---------------------------------------------------------------------------------------------- run 輸出
RUN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}")


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """只跟隨同一主機的 http(s) 轉址，避免 30x 把 GET 帶去其他主機或非 http(s) 目標（SSRF 防護）."""

    def redirect_request(  # noqa: PLR0913, PLR0917 - signature fixed by urllib.request.HTTPRedirectHandler
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        """Follow a redirect only to an http(s) URL on the same host."""
        parsed = urllib.parse.urlsplit(newurl)
        if (
            parsed.scheme not in ("http", "https")
            or parsed.netloc != urllib.parse.urlsplit(req.full_url).netloc
        ):
            raise urllib.request.HTTPError(newurl, code, msg, headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# 不走系統代理（與 phasyn_cli.machine 同一做法）；controller 由操作者指定，只送 GET。
_OPENER = urllib.request.build_opener(
    _SameHostRedirect, urllib.request.ProxyHandler({})
)


def _get_json(url: str, timeout: float) -> Any:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username is not None
    ):
        raise ValueError(
            f"controller URL 必須是 http(s)、帶主機名且不含帳號密碼：{url}"
        )
    request = urllib.request.Request(  # noqa: S310 - The URL above is restricted to HTTP(S) with a host.
        url, method="GET", headers={"Accept": "application/json"}
    )
    with _OPENER.open(request, timeout=timeout) as resp:
        return json.loads(resp.read())


def run_pairs(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Run JSON → [{dit_step, decode_step, latent_payload: FileRef, image: FileRef}]（只看已完成的步驟）."""
    pipeline_steps = {
        str(s.get("step_id")): s
        for s in ((run.get("request") or {}).get("pipeline") or {}).get("steps") or []
    }
    states = run.get("steps") or {}
    found: list[dict[str, Any]] = []
    for step_id, state in states.items():
        for port, output in (state.get("outputs") or {}).items():
            if not isinstance(output, Mapping) or output.get("type_id") != LATENT_TYPE:
                continue
            ref = output.get("file") or {}
            payload = ((ref.get("metadata") or {}).get("links") or {}).get("payload")
            if not payload:
                continue
            for consumer_id, consumer in pipeline_steps.items():
                bindings = consumer.get("inputs") or {}
                if not any(
                    isinstance(b, Mapping)
                    and b.get("from_step") == step_id
                    and b.get("output") == port
                    for b in bindings.values()
                ):
                    continue
                consumer_state = states.get(consumer_id) or {}
                if consumer_state.get("state") != "succeeded":
                    continue
                for out in (consumer_state.get("outputs") or {}).values():
                    file = (out or {}).get("file") or {}
                    if file.get("media_type") == "image/png":
                        found.append(
                            {
                                "run_id": run.get("run_id"),
                                "dit_step": step_id,
                                "decode_step": consumer_id,
                                "latent_payload": dict(payload),
                                "image": dict(file),
                            }
                        )
    return found


def read_node_file(data_dir: Path, ref: Mapping[str, Any]) -> bytes:
    """Read the specified payload from the local Node file store."""
    path = data_dir / "files" / str(ref["file_id"]) / "payload"
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if ref.get("sha256") and sha != ref["sha256"]:
        raise ValueError(f"{path} 的 SHA-256 與 FileRef 不符")
    return data


def collect(args: argparse.Namespace) -> list[Pair]:
    """Collect matching latent and image pairs from the selected runs."""
    pairs: list[Pair] = []
    for latent_path, image_path in args.pair or []:
        pairs.append(
            pair_from_bytes(
                Path(latent_path).read_bytes(),
                Path(image_path).read_bytes(),
                provenance={
                    "latent_file": str(latent_path),
                    "image_file": str(image_path),
                    "synthetic": args.synthetic,
                },
            )
        )
    if args.run:
        if not args.controller or not args.data_dir:
            raise SystemExit("--run 需要 --controller 與 --data-dir")
        for run_id in args.run:
            if not RUN_ID_RE.fullmatch(
                run_id
            ):  # URL path tampering guard: run_id is letters, digits and _ . : - only
                raise SystemExit(f"run_id 格式不正確（僅英數與 _ . : -）：{run_id}")
            run = _get_json(
                f"{args.controller.rstrip('/')}/api/runs/{run_id}", args.timeout
            )
            found = run_pairs(run)
            if not found:
                print(  # noqa: T201 - This utility reports progress and errors on the terminal.
                    f"run {run_id}：沒有找到 (qimg.latent.v1, PNG) 配對",
                    file=sys.stderr,
                )
            for item in found:
                try:
                    latent = read_node_file(Path(args.data_dir), item["latent_payload"])
                    image = read_node_file(Path(args.data_dir), item["image"])
                except (OSError, ValueError) as exc:
                    print(  # noqa: T201 - This utility reports progress and errors on the terminal.
                        f"run {run_id} {item['dit_step']}：略過（{exc}）",
                        file=sys.stderr,
                    )
                    continue
                pairs.append(
                    pair_from_bytes(
                        latent,
                        image,
                        provenance={
                            "run_id": run_id,
                            "dit_step": item["dit_step"],
                            "decode_step": item["decode_step"],
                            "synthetic": False,
                        },
                    )
                )
    return pairs


def main(argv: list[str] | None = None) -> int:
    """Fit preview coefficients from the supplied inputs."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--pair", nargs=2, action="append", metavar=("LATENT_SAFETENSORS", "IMAGE_PNG")
    )
    parser.add_argument("--run", action="append", help="已完成的 run_id（可重複）")
    parser.add_argument(
        "--controller", help="controller URL（只送 GET），例如 http://127.0.0.1:8080"
    )
    parser.add_argument(
        "--data-dir", help="跑 qimg.dit／vae_decode 的 Node 資料目錄（含 files/）"
    )
    parser.add_argument("--output", required=True, help="係數 JSON 輸出路徑")
    parser.add_argument("--force", action="store_true", help="輸出檔已存在時覆寫")
    parser.add_argument(
        "--ridge",
        type=float,
        default=0.0,
        help="矩陣部分的 L2（預設 0\N{FULLWIDTH EQUALS SIGN}純最小平方）",
    )
    parser.add_argument("--min-pairs", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--synthetic",
        action="store_true",
        help="標記 --pair 輸入為合成資料（只用於測試）",
    )
    args = parser.parse_args(argv)
    output = Path(args.output)
    if output.exists() and not args.force:
        print(f"{output} 已存在；需要 --force 才覆寫", file=sys.stderr)  # noqa: T201 - This utility reports progress and errors on the terminal.
        return 2
    pairs = collect(args)
    if len(pairs) < args.min_pairs:
        print(f"配對數 {len(pairs)} 少於 --min-pairs {args.min_pairs}", file=sys.stderr)  # noqa: T201 - This utility reports progress and errors on the terminal.
        return 2
    result = fit(pairs, ridge=args.ridge)
    stats = evaluate(result["beta"], pairs)
    doc = build_document(result["beta"], stats=stats, pairs=pairs, ridge=args.ridge)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(  # noqa: T201 - This utility reports progress and errors on the terminal.
        json.dumps(
            {"output": str(output), "pairs": len(pairs), **stats}, ensure_ascii=False
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
