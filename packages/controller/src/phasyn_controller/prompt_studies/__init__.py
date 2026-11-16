"""Prompt studies of the reasoning Studio (x-phasyn-extension): reverse-engineering a prompt from an image.

A study document keeps only the user's research state (source image, versions, tasks with references to their
results, the accepted version). Captioning, analysis, revision, comparison and rendering are ordinary runs
(qimg.vision, prompt.scene_compile / scene_score, t2i wiring) that the reasoning Studio frontend sends step by
step, each on an explicit user action. The controller has no background executor: nothing is scheduled,
resumed, resent or retried.

- ``checks``: integrity rules beyond the contract (422 invalid document, 409 conflict with what is stored)
- ``store``: the documents, with the revision check and the write under one lock
- ``deletion``: deleting a study in one request, and its preview
- ``references``: which runs a study refers to
- ``api``: the HTTP routes
"""

from .api import routes
from .checks import check_semantics, check_transition, scene_problems
from .deletion import DELETE_MODES, PromptStudyDeletion
from .references import deep_run_ids, study_run_ids
from .store import STORE_DIR, PromptStudyStore, summary

__all__ = [
    "DELETE_MODES",
    "STORE_DIR",
    "PromptStudyDeletion",
    "PromptStudyStore",
    "check_semantics",
    "check_transition",
    "deep_run_ids",
    "routes",
    "scene_problems",
    "study_run_ids",
    "summary",
]
