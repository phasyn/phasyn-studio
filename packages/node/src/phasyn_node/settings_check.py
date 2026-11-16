"""A component definition's settings, checked against its provider with exactly the rules of a settings PATCH.

Used when a definition is saved (``PUT /api/components/{id}``), when an instance starts, and to show why a
stored definition (for example a seed from the Node configuration) is refused. A provider that cannot be
described (runtime broken, provider not installed) refuses the definition instead of letting unchecked settings
in: the describe error (``PROVIDER_NOT_INSTALLED``, ``RUNTIME_UNAVAILABLE`` …, 422) is returned as is.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components.settings import validate_definition, validate_settings


def check_settings(definition: Mapping[str, Any], description: Mapping[str, Any]) -> None:
    """422 ``UNSUPPORTED_SETTING`` (``details.errors`` lists the problems) unless the provider accepts every setting.

    The definition must satisfy the InstanceDefinition contract; its settings then go through the checks of
    ``PATCH …/settings`` (``validate_settings``): the InstanceSettings contract, the provider's ``settings_schema``
    (unknown fields included) and ``part_overrides`` against the provider's parts.
    """
    validate_definition(definition)
    validate_settings(
        definition["settings"],
        settings_schema=description.get("settings_schema") or None,
        parts=list(description.get("parts") or []),
    )


__all__ = ["check_settings"]
