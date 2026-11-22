"""Component load policy (``InstanceDefinition.load_policy``, contract ``LoadPolicy``).

- ``resident`` (the default, also when the field is absent): started and stopped only by a person or by
  ``autostart``; the Controller never starts it on use, never unloads it when idle and never stops it to make
  room in an exclusive group.
- ``on_demand``: loaded on use. When a run's step needs it while it is stopped, the Controller starts it, waits
  for ``ready`` and then sends the call; after ``idle_unload_seconds`` (default
  :data:`DEFAULT_IDLE_UNLOAD_SECONDS`) without use the Controller stops it again, never while it is busy or a
  queued step still needs it.

The functions read a definition or a ComponentDescriptor alike (both carry the same two fields).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal


LoadPolicy = Literal["resident", "on_demand"]

DEFAULT_IDLE_UNLOAD_SECONDS = 600


def load_policy(doc: Mapping[str, Any]) -> LoadPolicy:
    """The policy of a definition or descriptor; anything but ``on_demand`` is ``resident``."""
    return "on_demand" if doc.get("load_policy") == "on_demand" else "resident"


def is_on_demand(doc: Mapping[str, Any]) -> bool:
    """Whether the component is loaded on use (and unloaded when idle)."""
    return load_policy(doc) == "on_demand"


def idle_unload_seconds(doc: Mapping[str, Any]) -> int:
    """Seconds of idleness after which an on_demand component is stopped (the stored value or the default)."""
    value = doc.get("idle_unload_seconds")
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return DEFAULT_IDLE_UNLOAD_SECONDS


__all__ = [
    "DEFAULT_IDLE_UNLOAD_SECONDS",
    "LoadPolicy",
    "idle_unload_seconds",
    "is_on_demand",
    "load_policy",
]
