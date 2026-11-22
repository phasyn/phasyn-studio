"""A retry's predecessor is verified without holding the receipt database, and a changed predecessor is never trusted."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from typing import Any

import pytest
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore

from phasyn_node.calls import CallStore, StaleParentError


NODE = str(uuid.uuid4())
COMPONENT = "dit"
PROVIDER = "provider.a"


def _body(call_id: str, retry_of: dict[str, Any] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "call_id": call_id,
        "run_id": "00000000-0000-4000-8000-000000000001",
        "step_id": "denoise",
        "inputs": {},
    }
    if retry_of is not None:
        body["retry_of"] = retry_of
    return body


def _rejected_parent(store: CallStore) -> dict[str, Any]:
    """A predecessor the component refused as busy: replacing it is allowed."""
    parent = _body(str(uuid.uuid4()))
    assert store.claim(COMPONENT, parent, PROVIDER, safe=True, verified=None)
    store.seal(
        parent["call_id"],
        error=ComponentError("COMPONENT_BUSY", "busy").to_dict(),
    )
    return {"call_id": parent["call_id"], "request_digest": digest(parent)}


@pytest.fixture
def store(tmp_path: Path) -> CallStore:
    return CallStore(tmp_path / "calls.sqlite", NODE, "boot-1")


@pytest.fixture
def files(tmp_path: Path) -> FileStore:
    return FileStore(tmp_path / "files", NODE)


def test_the_predecessor_is_verified_before_the_claim_locks_the_database(
    store: CallStore, files: FileStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    retry_of = _rejected_parent(store)
    checks: list[str] = []
    original = CallStore._verify_outcome

    def verify(self: CallStore, receipt: dict[str, Any], fs: FileStore) -> None:
        # Hashing outputs here must leave the database free for other writers.
        with sqlite3.connect(self.path, timeout=0) as other:
            other.execute("BEGIN IMMEDIATE")
            other.rollback()
        checks.append(receipt["call_id"])
        original(self, receipt, fs)

    monkeypatch.setattr(CallStore, "_verify_outcome", verify)
    child = _body(str(uuid.uuid4()), retry_of)
    verified = store.verify_parent(COMPONENT, child, files)
    assert checks == [retry_of["call_id"]]
    assert store.claim(COMPONENT, child, PROVIDER, safe=True, verified=verified)
    assert checks == [retry_of["call_id"]]  # the claim itself verifies nothing
    assert (
        store.receipt(COMPONENT, retry_of["call_id"], files)["superseded_by"]
        == (child["call_id"])
    )


def test_a_predecessor_changed_after_verification_is_not_trusted(
    store: CallStore, files: FileStore
) -> None:
    retry_of = _rejected_parent(store)
    child = _body(str(uuid.uuid4()), retry_of)
    verified = store.verify_parent(COMPONENT, child, files)
    store.fence_cancel(COMPONENT, retry_of["call_id"])
    with pytest.raises(StaleParentError):
        store.claim(COMPONENT, child, PROVIDER, safe=True, verified=verified)
    fresh = store.verify_parent(COMPONENT, child, files)
    with pytest.raises(ComponentError) as refused:
        store.claim(COMPONENT, child, PROVIDER, safe=True, verified=fresh)
    assert refused.value.code == "STATE_CONFLICT"
    with sqlite3.connect(store.path) as db:
        assert not db.execute(
            "SELECT 1 FROM calls WHERE id=?", (child["call_id"],)
        ).fetchone()


def test_a_verification_error_is_raised_only_when_the_call_is_new(
    store: CallStore, files: FileStore
) -> None:
    child = _body(
        str(uuid.uuid4()), {"call_id": str(uuid.uuid4()), "request_digest": "0" * 64}
    )
    verified = store.verify_parent(COMPONENT, child, files)
    assert verified is not None and isinstance(verified[1], ComponentError)
    with pytest.raises(ComponentError) as missing:
        store.claim(COMPONENT, child, PROVIDER, safe=True, verified=verified)
    assert missing.value.code == "NOT_FOUND"
    with sqlite3.connect(store.path) as db:
        db.execute(
            "INSERT INTO calls VALUES(?,?,?)", (child["call_id"], "boot-1", "{}")
        )
    # An already recorded call is replayed by id; its predecessor is not consulted again.
    assert not store.claim(COMPONENT, child, PROVIDER, safe=True, verified=verified)
    with pytest.raises(ValueError, match="verified predecessor"):
        store.claim(COMPONENT, child, PROVIDER, safe=True, verified=None)
