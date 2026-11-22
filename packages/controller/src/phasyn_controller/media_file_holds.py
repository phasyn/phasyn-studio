"""Protect immutable source files while a Studio or timeline command adopts them."""

from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from typing import TYPE_CHECKING
from weakref import WeakKeyDictionary

from .studio_take_source import conflict


if TYPE_CHECKING:
    from collections.abc import Iterator

    from .state import Controller


type FileKey = tuple[str, str]
_HELD: WeakKeyDictionary[Controller, Counter[FileKey]] = WeakKeyDictionary()


def pending_media_files(ctl: Controller) -> set[FileKey]:
    """Return source and output files that a pending adoption is pinning against run purge."""
    return set(_HELD[ctl]) if ctl in _HELD else set()


@contextmanager
def hold_media_files(ctl: Controller, keys: set[FileKey]) -> Iterator[None]:
    """Pin exact file keys until a project or timeline write makes their references durable."""
    # Both the transfer and purge admission run on the Controller's event loop.
    if ctl.purge.busy:
        raise conflict("media_purge_in_progress")
    counts = _HELD.setdefault(ctl, Counter())
    counts.update(keys)
    try:
        yield
    finally:
        for key in keys:
            counts[key] -= 1
            if counts[key] == 0:
                del counts[key]
