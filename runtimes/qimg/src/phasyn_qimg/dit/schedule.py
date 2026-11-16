# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/schedulers/scheduling_flow_match_euler_discrete.py,
# Copyright 2025 Stability AI, Katherine Crowson and The HuggingFace Team; calculate_shift from
# src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py, Copyright 2026 Qwen-Image Team,
# The HuggingFace Team); modified by the Phasyn Studio authors (rewritten in numpy, torch-free).
"""FlowMatch Euler noise schedule of Qwen-Image 2.1 (torch-free, numpy).

Reproduced formula by formula (same numpy operation order and dtypes):
- ``np.linspace(1.0, 1/steps, steps)`` and ``calculate_shift`` from ``QwenImage21Pipeline.__call__``;
- non-native schedules are expressed as ``use_karras_sigmas``/``use_exponential_sigmas``; a custom flow
  shift μ turns dynamic shifting off and uses ``shift = exp(μ)`` (the terminal stretch is kept);
- the shift, ``shift_terminal``, Karras/exponential conversions and the terminal 0 of
  ``FlowMatchEulerDiscreteScheduler.set_timesteps(sigmas=…, mu=…)``.

It reproduces diffusers' numbers. Unsupported settings (beta sigmas,
invert_sigmas, stochastic sampling, a custom μ with a non-exponential time shift) are rejected, never
silently changed.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

SIGMA_SCHEDULES = ("native", "karras", "exponential")
SCHEDULER_CLASS = "FlowMatchEulerDiscreteScheduler"


class ScheduleError(ValueError):
    """排程設定不被支援（呼叫端轉成 422）。"""


@dataclass(frozen=True)
class SchedulerSpec:
    num_train_timesteps: int
    shift: float
    use_dynamic_shifting: bool
    base_shift: float
    max_shift: float
    base_image_seq_len: int
    max_image_seq_len: int
    shift_terminal: float | None
    time_shift_type: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "num_train_timesteps": self.num_train_timesteps,
            "shift": self.shift,
            "use_dynamic_shifting": self.use_dynamic_shifting,
            "base_shift": self.base_shift,
            "max_shift": self.max_shift,
            "base_image_seq_len": self.base_image_seq_len,
            "max_image_seq_len": self.max_image_seq_len,
            "shift_terminal": self.shift_terminal,
            "time_shift_type": self.time_shift_type,
        }


def scheduler_spec(config: Mapping[str, Any]) -> SchedulerSpec:
    """``scheduler/scheduler_config.json`` → 已驗證的 spec（預設值與 diffusers 的 ``__init__`` 相同）。"""
    cls = config.get("_class_name")
    if cls not in (None, SCHEDULER_CLASS):
        raise ScheduleError(f"只支援 {SCHEDULER_CLASS}，scheduler_config 是 {cls}")
    for flag in ("use_beta_sigmas", "use_karras_sigmas", "use_exponential_sigmas"):
        if config.get(flag):
            raise ScheduleError(f"scheduler_config 已啟用 {flag}；排程只能由參數 sigma_schedule 明確選擇")
    if config.get("invert_sigmas"):
        raise ScheduleError("不支援 invert_sigmas=true 的排程（Qwen-Image 不使用）")
    if config.get("stochastic_sampling"):
        raise ScheduleError("不支援 stochastic_sampling=true（DiT 只實作確定性 Euler 更新）")
    time_shift_type = str(config.get("time_shift_type", "exponential"))
    if time_shift_type not in ("exponential", "linear"):
        raise ScheduleError(f"time_shift_type 必須是 exponential 或 linear，收到 {time_shift_type}")
    terminal = config.get("shift_terminal")
    return SchedulerSpec(
        num_train_timesteps=int(config.get("num_train_timesteps", 1000)),
        shift=float(config.get("shift", 1.0)),
        use_dynamic_shifting=bool(config.get("use_dynamic_shifting", False)),
        base_shift=float(config.get("base_shift", 0.5)),
        max_shift=float(config.get("max_shift", 1.15)),
        base_image_seq_len=int(config.get("base_image_seq_len", 256)),
        max_image_seq_len=int(config.get("max_image_seq_len", 4096)),
        shift_terminal=None if terminal is None else float(terminal),
        time_shift_type=time_shift_type,
    )


def calculate_shift(
    image_seq_len: int,
    base_seq_len: int = 256,
    max_seq_len: int = 4096,
    base_shift: float = 0.5,
    max_shift: float = 1.15,
) -> float:
    """pipeline 的解析度相依 μ（逐式同 diffusers ``calculate_shift``）。"""
    m = (max_shift - base_shift) / (max_seq_len - base_seq_len)
    b = base_shift - m * base_seq_len
    return image_seq_len * m + b


@dataclass(frozen=True)
class Schedule:
    """一次去噪的實際排程。``sigmas`` 是 float32、長度 = steps（不含 terminal 0，與 scheduler 轉 tensor 前相同）。"""

    steps: int
    sigmas: np.ndarray
    num_train_timesteps: int
    sigma_schedule: str
    flow_shift_mu: float | None
    pipeline_mu: float
    effective_mu: float
    mu_source: str

    def timesteps(self) -> np.ndarray:
        """``sigmas * num_train_timesteps``（float32）；DiT 以 ``timestep / 1000`` 傳入 transformer。"""
        return (self.sigmas * self.num_train_timesteps).astype(np.float32)

    def sigmas_with_terminal(self) -> list[float]:
        """紀錄用：每個 float32 sigma 的精確十進位（含最後的 terminal 0）。"""
        return [float(s) for s in self.sigmas] + [0.0]

    def to_meta(self) -> dict[str, Any]:
        return {
            "steps": self.steps,
            "sigma_schedule": self.sigma_schedule,
            "flow_shift_mu": self.flow_shift_mu,
            "sigmas": self.sigmas_with_terminal(),
            "timesteps": [float(t) for t in self.timesteps()],
            "mu": self.effective_mu,
            "mu_source": self.mu_source,
            "pipeline_mu": self.pipeline_mu,
        }


def _time_shift(spec: SchedulerSpec, mu: float, sigma: float, t: np.ndarray) -> np.ndarray:
    if spec.time_shift_type == "exponential":
        return math.exp(mu) / (math.exp(mu) + (1 / t - 1) ** sigma)
    return mu / (mu + (1 / t - 1) ** sigma)


def _stretch_shift_to_terminal(t: np.ndarray, shift_terminal: float) -> np.ndarray:
    one_minus_z = 1 - t
    scale_factor = one_minus_z[-1] / (1 - shift_terminal)
    stretched_t = 1 - (one_minus_z / scale_factor)
    return stretched_t


def _convert_to_karras(in_sigmas: np.ndarray, num_inference_steps: int) -> np.ndarray:
    sigma_min = in_sigmas[-1].item()
    sigma_max = in_sigmas[0].item()
    rho = 7.0  # 與 diffusers 相同（論文值）
    ramp = np.linspace(0, 1, num_inference_steps)
    min_inv_rho = sigma_min ** (1 / rho)
    max_inv_rho = sigma_max ** (1 / rho)
    sigmas = (max_inv_rho + ramp * (min_inv_rho - max_inv_rho)) ** rho
    return sigmas


def _convert_to_exponential(in_sigmas: np.ndarray, num_inference_steps: int) -> np.ndarray:
    sigma_min = in_sigmas[-1].item()
    sigma_max = in_sigmas[0].item()
    sigmas = np.exp(np.linspace(math.log(sigma_max), math.log(sigma_min), num_inference_steps))
    return sigmas


def build_schedule(
    spec: SchedulerSpec,
    *,
    steps: int,
    image_seq_len: int,
    sigma_schedule: str = "native",
    flow_shift_mu: float | None = None,
) -> Schedule:
    """``steps`` 步的 sigma 排程；``image_seq_len`` 是目標 latent token 數（H/16·W/16，不含參考圖）。"""
    if steps < 2:
        # Qwen's terminal stretch divides by zero for a single sigma
        raise ScheduleError("Qwen-Image 至少需要 2 個取樣步驟")
    if sigma_schedule not in SIGMA_SCHEDULES:
        raise ScheduleError(f"sigma_schedule 必須是 {'／'.join(SIGMA_SCHEDULES)}，收到 {sigma_schedule}")
    use_dynamic = spec.use_dynamic_shifting
    shift = spec.shift
    if flow_shift_mu is not None:
        if not math.isfinite(flow_shift_mu):
            raise ScheduleError("flow_shift_mu 必須是有限數值")
        if spec.time_shift_type != "exponential":
            raise ScheduleError("自訂 flow shift μ 只支援 exponential time_shift_type")
        # exp(μ)·σ / (1 + (exp(μ)−1)·σ)：關閉 dynamic shifting，pipeline 自動算的 μ 不再覆蓋設定值
        use_dynamic = False
        shift = math.exp(flow_shift_mu)

    # pipeline：sigmas 與解析度相依的 μ（μ 永遠會傳給 set_timesteps；static shift 時 scheduler 忽略它）
    sigmas_in = np.linspace(1.0, 1 / steps, steps)
    mu = calculate_shift(
        image_seq_len, spec.base_image_seq_len, spec.max_image_seq_len, spec.base_shift, spec.max_shift
    )

    # scheduler.set_timesteps(sigmas=…, mu=…)
    sigmas = np.array(sigmas_in).astype(np.float32)
    num_inference_steps = len(sigmas)
    if use_dynamic:
        sigmas = _time_shift(spec, mu, 1.0, sigmas)
    else:
        sigmas = shift * sigmas / (1 + (shift - 1) * sigmas)
    if spec.shift_terminal:
        sigmas = _stretch_shift_to_terminal(sigmas, spec.shift_terminal)
    if sigma_schedule == "karras":
        sigmas = _convert_to_karras(sigmas, num_inference_steps)
    elif sigma_schedule == "exponential":
        sigmas = _convert_to_exponential(sigmas, num_inference_steps)
    sigmas = np.asarray(sigmas).astype(np.float32)
    values = [float(s) for s in sigmas]
    if not all(math.isfinite(v) for v in values):
        raise ScheduleError("排程產生非有限的 sigma")
    if any(left <= right for left, right in itertools.pairwise(values)) or values[-1] <= 0.0:
        raise ScheduleError("排程的 sigma 必須嚴格遞減且大於 0（terminal 0 另外附加）")

    if flow_shift_mu is not None:
        effective_mu, source = float(flow_shift_mu), "custom"
    elif use_dynamic:
        effective_mu, source = float(mu), "pipeline"
    else:
        effective_mu, source = math.log(shift), "native_static"
    return Schedule(
        steps=steps,
        sigmas=sigmas,
        num_train_timesteps=spec.num_train_timesteps,
        sigma_schedule=sigma_schedule,
        flow_shift_mu=flow_shift_mu,
        pipeline_mu=float(mu),
        effective_mu=effective_mu,
        mu_source=source,
    )


__all__ = [
    "SIGMA_SCHEDULES",
    "Schedule",
    "ScheduleError",
    "SchedulerSpec",
    "build_schedule",
    "calculate_shift",
    "scheduler_spec",
]
