"""A component definition is checked by its provider exactly like a settings PATCH (D-02).

Unknown fields and unsupported values are 422 UNSUPPORTED_SETTING with details; a provider that cannot be
described (not installed, runtime broken) refuses the definition instead of letting unchecked settings in; a
seed from the Node configuration that the provider refuses is shown with that error and cannot start.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from node_testkit import assert_valid, echo_definition, make_config, running_node


pytestmark = pytest.mark.anyio


def refused(definition: dict[str, Any], **settings: Any) -> dict[str, Any]:
    out = copy.deepcopy(definition)
    for root, values in settings.items():
        out["settings"][root].update(values)
    return out


async def test_put_checks_settings_with_the_provider(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    url = "/api/components/extra"
    base = echo_definition("extra", group="cpu-extra")
    cases = [
        (refused(base, invoke={"bogus": 1}), "bogus"),  # unknown field
        (
            refused(base, load={"precision": {"compute_dtype": "int3"}}),
            "int3",
        ),  # unsupported value
        (
            refused(
                base,
                load={
                    "part_overrides": [
                        {"selector": "nothing.*", "settings": {"compute_dtype": "fp32"}}
                    ]
                },
            ),
            "nothing.*",
        ),
    ]
    async with running_node(config) as node:
        for definition, culprit in cases:
            resp = await node.client.put(url, json=definition)
            assert resp.status_code == 422, resp.text
            body = resp.json()
            assert body["code"] == "UNSUPPORTED_SETTING" and culprit in json.dumps(
                body["details"], ensure_ascii=False
            )
        assert "extra" not in node.service.instances
        assert not (config.data_dir / "config" / "components" / "extra.json").exists()

        created = await node.client.put(url, json=base)
        assert created.status_code == 200, created.text
        assert_valid("ComponentDescriptor", created.json())
        # one set of rules: what PUT refuses, a settings PATCH refuses too
        patched = await node.client.patch(
            f"{url}/settings", json={"patch": {"invoke": {"bogus": 1}}}
        )
        assert (
            patched.status_code == 422
            and patched.json()["code"] == "UNSUPPORTED_SETTING"
        )
        replaced = await node.client.put(url, json=refused(base, invoke={"bogus": 1}))
        assert (
            replaced.status_code == 422
            and node.service.instances["extra"].settings.stored["invoke"] == {}
        )
