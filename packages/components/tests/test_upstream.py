"""phasyn_components.upstream: pinned-source checks that never raise for a vanished symbol."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from phasyn_components import upstream


def _fake_distribution(version: str, direct_url: dict[str, Any] | None) -> Any:
    text = json.dumps(direct_url) if direct_url is not None else None
    return SimpleNamespace(version=version, read_text=lambda name: text if name == "direct_url.json" else None)


@pytest.mark.parametrize(
    ("url", "public"),
    [
        ("https://example.invalid/org/repo.git", "https://example.invalid/org/repo.git"),
        (
            "https://user:token@example.invalid:8443/org/repo?private_token=t#frag",
            "https://example.invalid:8443/org/repo",
        ),
        ("ssh://git@example.invalid/org/repo.git", "ssh://example.invalid/org/repo.git"),
        ("git://[2001:db8::1]/repo", "git://[2001:db8::1]/repo"),
        ("file:///home/user/src/diffusers", None),
        ("/home/user/src/diffusers", None),
        ("https://example.invalid:99999/x", None),
        (None, None),
    ],
)
def test_vcs_source_never_carries_local_paths_or_credentials(
    monkeypatch: pytest.MonkeyPatch, url: str | None, public: str | None
) -> None:
    dist = _fake_distribution("1.0", {"url": url, "vcs_info": {"commit_id": "578c9b2"}})
    monkeypatch.setattr(upstream.importlib.metadata, "distribution", lambda name: dist)
    assert upstream.vcs_source("diffusers") == {"url": public, "commit_id": "578c9b2"}
