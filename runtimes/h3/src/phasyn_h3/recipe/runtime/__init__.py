"""MiniMax H3 stage runtime over the pinned SGLang implementation.

Importing this package never imports torch or SGLang: the policy, lifecycle and
bundle modules are pure Python so they can be tested in the torch-free
control-plane environment.  GPU code paths import torch and SGLang lazily inside
the component process (see ``backend`` and ``sglang_env``).
"""

from __future__ import annotations

from phasyn_h3.recipe.adapter.constants import (
    FAMILY,
    H3_GIT_REVISION as MINIMAX_H3_REPO_REVISION,
    SGLANG_REVISION as SGLANG_SOURCE_REVISION,
)


PROVIDER_ID = "sglang_h3"
SGLANG_REPOSITORY = "https://github.com/sgl-project/sglang"
# setuptools-scm version uv's own metadata build of the git source produced
# (deploy/runtimes/*/pyproject.toml dependency-metadata block).
SGLANG_BUILT_VERSION = "0.5.6.post3.dev12079+gde487f803"
# Recipe identity, not the package version: it is hashed into every bundle's ``adapter_digest``
# (stages/common.py), so changing it changes bundle identities. Bump it only with a numeric recipe change.
SHIM_VERSION = "1.0.0"
PROVIDER_VERSION = f"{SHIM_VERSION}+sglang.{SGLANG_SOURCE_REVISION}"

__all__ = [
    "FAMILY",
    "MINIMAX_H3_REPO_REVISION",
    "PROVIDER_ID",
    "PROVIDER_VERSION",
    "SGLANG_BUILT_VERSION",
    "SGLANG_REPOSITORY",
    "SGLANG_SOURCE_REVISION",
    "SHIM_VERSION",
]
