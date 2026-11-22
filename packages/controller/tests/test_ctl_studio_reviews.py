"""Boundary of the take review write: body size, take id format, unknown project or take, and that a write never
changes the project document (its revision stays, so a person's next save does not conflict)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from controller_support import Harness
from phasyn_components import contracts
from test_ctl_studio import project

from phasyn_controller.studio_reviews import MAX_BODY_BYTES


REVIEW = {
    "take_id": "t1",
    "kind": "adherence",
    "source": "vlm-adherence",
    "role": "generated",
    "score": 0.5,
    "statements": [
        {
            "id": "s1",
            "text": "a cat is visible",
            "kind": "identity",
            "verdict": "no",
            "p_yes": 0.1,
        }
    ],
}


def test_review_write_boundaries(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            saved = (
                await h.client.put("/api/studio/projects/p1", json=project())
            ).json()
            url = "/api/studio/projects/p1/reviews"

            missing = await h.client.post(
                "/api/studio/projects/nope/reviews", json={"reviews": [REVIEW]}
            )
            assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"
            assert (
                await h.client.get("/api/studio/projects/nope/reviews")
            ).status_code == 404

            bad_id = await h.client.post(
                url, json={"reviews": [{**REVIEW, "take_id": "../t1"}]}
            )
            assert (
                bad_id.status_code == 422
                and bad_id.json()["code"] == "INVALID_ARGUMENT"
            )
            unknown = await h.client.post(
                url, json={"reviews": [REVIEW, {**REVIEW, "take_id": "t9"}]}
            )
            assert unknown.status_code == 422 and unknown.json()["details"][
                "unknown_take_ids"
            ] == ["t9"]
            mixed = await h.client.post(
                url, json={"reviews": [{**REVIEW, "kind": "residue"}]}
            )
            assert mixed.status_code == 422
            twice = await h.client.post(url, json={"reviews": [REVIEW, REVIEW]})
            assert twice.status_code == 422

            pad = "x" * (MAX_BODY_BYTES + 1)
            too_large = await h.client.post(
                url, json={"reviews": [{**REVIEW, "note": pad}]}
            )
            assert (
                too_large.status_code == 413
                and too_large.json()["code"] == "PAYLOAD_TOO_LARGE"
            )
            empty = (await h.client.get(url)).json()
            assert empty["revision"] == 0 and empty["reviews"] == []

            written = await h.client.post(url, json={"reviews": [REVIEW]})
            assert written.status_code == 200, written.text
            contracts.validate("StudioTakeReviewsWriteResult", written.json())
            again = (
                await h.client.post(url, json={"reviews": [{**REVIEW, "score": 1.0}]})
            ).json()
            assert again["replaced"] == 1 and again["reviews"]["revision"] == 2
            assert [r["score"] for r in again["reviews"]["reviews"]] == [1.0]

            after = (await h.client.get("/api/studio/projects/p1")).json()
            assert (
                after["revision"] == saved["revision"]
                and after["updated_at"] == saved["updated_at"]
            )

            deleted = await h.client.delete(
                f"/api/studio/projects/p1?revision={saved['revision']}"
            )
            assert deleted.status_code == 200
            assert not (
                h.config.data_dir / "config" / "studio" / "_reviews" / "p1.json"
            ).exists()

    asyncio.run(scenario())
