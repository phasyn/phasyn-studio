"""Component processes get a minimal environment: the passthrough list, the runtime entry's own env, and the
variables the Node sets itself. Nothing else (tokens, proxies, the test-provider switch) leaks from the Node."""

from __future__ import annotations

import sys

import pytest
from phasyn_components import testing
from phasyn_components.runtime_env import ENV_FFMPEG, ENV_FFPROBE, RUNTIME_ID_ENV, SOURCE_REVISION_ENV
from phasyn_node import sysinfo
from phasyn_node.config import RuntimeEntry


def entry(**env: str) -> RuntimeEntry:
    return RuntimeEntry(runtime_id="cpu", python=sys.executable, module="phasyn_components.runtime_host", env=env)


def test_runtime_env_is_a_whitelist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_FFMPEG, "/opt/ffmpeg/bin/ffmpeg")
    monkeypatch.setenv(ENV_FFPROBE, "/opt/ffmpeg/bin/ffprobe")
    monkeypatch.setenv("UNRELATED_SECRET", "x")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv(testing.ENABLE_ENV, "1")  # only the config may enable test providers
    env = sysinfo.runtime_env(entry(), device=None, source_rev="rev-1")
    assert env[ENV_FFMPEG] == "/opt/ffmpeg/bin/ffmpeg" and env[ENV_FFPROBE] == "/opt/ffmpeg/bin/ffprobe"
    assert "UNRELATED_SECRET" not in env and "HTTPS_PROXY" not in env and testing.ENABLE_ENV not in env
    assert env[RUNTIME_ID_ENV] == "cpu" and env[SOURCE_REVISION_ENV] == "rev-1"
    assert env["PYTHONUNBUFFERED"] == "1" and env["CUDA_VISIBLE_DEVICES"] == ""

    enabled = sysinfo.runtime_env(entry(**{testing.ENABLE_ENV: "1"}), device=None, source_rev="rev-1")
    assert enabled[testing.ENABLE_ENV] == "1"
