"""The editing core of the Studio timeline: clip arithmetic, edits, normalization and derived facts.

Pure functions on plain JSON documents (no I/O, no clock, no randomness except the id allocator a caller
passes in), shared by the Controller and its tests. The browser keeps its own interactive twin of the edits;
``contracts/examples/timeline-commands`` holds the vectors both must satisfy.

- :func:`normalize_project` keeps a project's timeline consistent with its shots and takes.
- :func:`apply_command` / :func:`apply_commands` apply the named commands of the wire contract.
- :func:`film_order`, :func:`previous_shot` and :func:`continuity_frame` are the facts clients derive from it.
- :class:`TimelineRejected` is the typed refusal: a stable ``reason`` and a sentence for people.
"""

from .commands import Applied, apply_command, apply_commands, check_command, execute_command, request_error
from .derived import continuity_frame, film_order, previous_shot
from .export import Exporter, export_request
from .model import AllocateId, Doc
from .normalize import TIMELINE_VERSION, normalize_project
from .rejection import REJECTED_CODE, TimelineRejected

__all__ = [
    "REJECTED_CODE",
    "TIMELINE_VERSION",
    "AllocateId",
    "Applied",
    "Doc",
    "Exporter",
    "TimelineRejected",
    "apply_command",
    "apply_commands",
    "check_command",
    "continuity_frame",
    "execute_command",
    "export_request",
    "film_order",
    "normalize_project",
    "previous_shot",
    "request_error",
]
