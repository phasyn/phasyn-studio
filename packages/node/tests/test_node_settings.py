"""設定保存與載入分開。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from node_testkit import (
    InvokeOptions,
    assert_valid,
    echo_definition,
    invoke_body,
    make_config,
    running_node,
)


pytestmark = pytest.mark.anyio


async def test_patch_is_stored_only_until_explicit_restart(tmp_path: Path) -> None:
    config = make_config(tmp_path, components=[echo_definition("echo")])
    async with running_node(config) as node:
        url = "/api/components/echo/settings"
        await node.start_ready("echo")
        view = (await node.client.get(url)).json()
        assert_valid("SettingsView", view)
        assert (
            view["stored_revision"],
            view["loaded_revision"],
            view["restart_required"],
        ) == (1, 1, False)
        assert (
            view["settings_schema"]["properties"]["load"]
            and view["parameters_schema"]["properties"]["steps"]
        )

        patched = await node.client.patch(
            url,
            json={
                "expected_revision": 1,
                "patch": {"load": {"precision": {"compute_dtype": "fp16"}}},
            },
        )
        assert patched.status_code == 200, patched.text
        view = patched.json()
        assert_valid("SettingsView", view)
        assert (
            view["stored_revision"],
            view["loaded_revision"],
            view["restart_required"],
        ) == (2, 1, True)
        assert view["stored"]["load"]["precision"]["compute_dtype"] == "fp16"
        assert view["loaded"]["precision"]["compute_dtype"] == "native"
        saved = json.loads(
            (config.data_dir / "config" / "components" / "echo.json").read_text(
                encoding="utf-8"
            )
        )
        assert saved["stored_revision"] == 2

        rejected = [
            (
                {"expected_revision": 1, "patch": {"invoke": {"steps": 1}}},
                409,
                "REVISION_CONFLICT",
            ),
            (
                {"patch": {"load": {"precision": {"compute_dtype": "int3"}}}},
                422,
                "UNSUPPORTED_SETTING",
            ),
            ({"patch": {"bogus": {}}}, 422, "UNSUPPORTED_SETTING"),
            (
                {
                    "patch": {
                        "load": {
                            "part_overrides": [
                                {
                                    "selector": "nothing.*",
                                    "settings": {"compute_dtype": "fp32"},
                                }
                            ]
                        }
                    }
                },
                422,
                "UNSUPPORTED_SETTING",
            ),
            (
                {
                    "patch": {
                        "load": {
                            "device": {
                                "kind": "cpu",
                                "id": "cpu",
                                "resource_group": "elsewhere",
                            }
                        }
                    }
                },
                409,
                "STATE_CONFLICT",
            ),
            ({"patch": {}, "extra": 1}, 422, "INVALID_ARGUMENT"),
        ]
        for body, status, code in rejected:
            response = await node.client.patch(url, json=body)
            assert (response.status_code, response.json()["code"]) == (status, code), (
                response.text
            )
        assert (await node.client.get(url)).json()["stored_revision"] == 2

        # 兩個 part 可以有不同設定；invoke defaults 只影響下一次 call
        parts = {
            "load": {
                "part_overrides": [
                    {"selector": "echo.stage_b", "settings": {"compute_dtype": "fp32"}}
                ]
            },
            "invoke": {"steps": 2},
        }
        view = (
            await node.client.patch(url, json={"expected_revision": 2, "patch": parts})
        ).json()
        assert view["stored_revision"] == 3 and view["loaded_revision"] == 1

        refused = await node.invoke(
            "echo",
            invoke_body(value=1, options=InvokeOptions(required_loaded_revision=3)),
        )
        assert (
            refused.status_code == 409
            and refused.json()["code"] == "SETTINGS_NOT_LOADED"
        )
        still_old = (
            await node.invoke(
                "echo",
                invoke_body(value=1, options=InvokeOptions(required_loaded_revision=1)),
            )
        ).json()
        assert still_old["state"] == "succeeded"
        assert (
            still_old["settings"]["effective"]["load"]["precision"]["compute_dtype"]
            == "native"
        )
        assert (
            still_old["settings"]["effective"]["parameters"]["steps"] == 2
        )  # invoke defaults 已用於下一個 call

        restarted = await node.control("echo", "restart")
        assert restarted.status_code == 200 and restarted.json()["state"] in (
            "stopping",
            "loading",
            "ready",
        )
        ready = await node.wait_state("echo", "ready")
        assert (
            ready["settings"]["stored_revision"],
            ready["settings"]["loaded_revision"],
        ) == (3, 3)
        assert ready["settings"]["restart_required"] is False
        result = (
            await node.invoke(
                "echo",
                invoke_body(value=1, options=InvokeOptions(required_loaded_revision=3)),
            )
        ).json()
        assert_valid("InvokeResult", result)
        settings = result["settings"]
        assert (settings["stored_revision"], settings["loaded_revision"]) == (3, 3)
        assert settings["effective"]["load"]["precision"]["compute_dtype"] == "fp16"
        assert settings["expanded_parts"]["echo.stage_b"]["compute_dtype"] == "fp32"
        assert settings["expanded_parts"]["echo.stage_a"]["compute_dtype"] == "fp16"
        assert (
            settings["observed"]["accumulation_dtype"] is None
        )  # 未知顯示 null，不假稱 FP32
