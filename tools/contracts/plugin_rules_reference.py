"""Reference evaluation of plugin rules.

The web UI has its own evaluator and does not import this module. It exists so that the shared vectors in ``contracts/examples/plugin-rules/`` are checked
against the written rules by something that runs: ``sync_studio_plugins.py --check`` and the repository tests
evaluate every case here and compare the result with the case's ``expect``.

Input: the registry (contract ``StudioPluginList``, or ``None`` when it could not be read), the project's
``prompt_plugins``, a prompt and, for generation settings, the values a shot would render with.
Output: ``problems`` (references that cannot be used), ``forbidden`` and ``missing`` (prompt rules; a per-shot
finding also names its ``shot``, a subject that no shot names its ``subject``), ``unmet`` (generation requirements),
the ``prompt`` to send and ``blocked``. Nothing is ever skipped silently: a reference that cannot be resolved or
belongs to a package that is not ``ok`` is a problem, and a problem blocks the render.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_components.plugin_manifest import PATTERN_FLAGS

KIND_RANK = {"style": 0, "effect": 1, "constraint": 2}
# The H3 field names that start a field when a line begins with one of them and a colon (ASCII or full width).
FIELD_HEADING = re.compile(
    r"[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description"
    r"|overall_soundscape|non_diegetic_music)[ \t]*[:：]"
)
# The fields whose text describes the picture shot by shot.
DESCRIPTION_FIELDS = frozenset({"detailed_description", "integrated_multimodal_description"})
# A shot marker: [Shot 2], or a span of one shot such as [Shot 1, 00:00.000-00:02.000] ("Shot" in any ASCII case).
SHOT_MARKER = re.compile(r"\[[Ss][Hh][Oo][Tt][ \t]*([0-9]{1,3})[ \t]*(?:,[^\]\n]*)?\]")
SUBJECT_TAG = re.compile(r"<Subject[ \t]*([0-9]{1,3})>")
DIALOGUE_OPEN = "<d>"
DIALOGUE_CLOSE = "</d>"
# Characters that count as one separator in phrase matching, alone or in a run: tab, line feed, carriage return,
# space, no-break space, ideographic space, hyphen-minus, hyphen, non-breaking hyphen, en dash.
SEPARATORS = frozenset(
    {
        "\t",
        "\n",
        "\r",
        " ",
        "\u00a0",  # no-break space
        "\u3000",  # ideographic space
        "-",
        "\u2010",  # hyphen
        "\u2011",  # non-breaking hyphen
        "\u2013",  # en dash
    }
)
# The typographic single quotation marks, left and right.
APOSTROPHES = frozenset({"\u2018", "\u2019"})
WORD_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_")
DETAILED = "detailed_description:"

Finding = dict[str, Any]


def normalize(text: str) -> str:
    """ASCII letters in lower case, typographic apostrophes as ``'``, every run of separators as one space."""
    out: list[str] = []
    for char in text:
        if char in SEPARATORS:
            if not out or out[-1] != " ":
                out.append(" ")
        elif char in APOSTROPHES:
            out.append("'")
        elif "A" <= char <= "Z":
            out.append(char.lower())
        else:
            out.append(char)
    return "".join(out)


def term_matches(term: str, normalized_prompt: str, *, word: bool) -> bool:
    """Whether the phrase occurs in the normalized prompt; ``word`` also needs a word boundary on both sides."""
    needle = normalize(term)
    start = normalized_prompt.find(needle)
    while start >= 0:
        end = start + len(needle)
        before = start == 0 or normalized_prompt[start - 1] not in WORD_CHARACTERS
        after = end == len(normalized_prompt) or normalized_prompt[end] not in WORD_CHARACTERS
        if not word or (before and after):
            return True
        start = normalized_prompt.find(needle, start + 1)
    return False


def _forbidden_match(item: Mapping[str, Any], prompt: str, normalized: str) -> str | None:
    """What a forbid item found: the matched text of a pattern, or the first matching phrase as written."""
    if "pattern" in item:
        hit = re.search(item["pattern"], prompt, PATTERN_FLAGS)
        return hit.group(0) if hit else None
    word = bool(item.get("word", False))
    return next((term for term in item["terms"] if term_matches(term, normalized, word=word)), None)


def _satisfied(item: Mapping[str, Any], prompt: str, normalized: str) -> bool:
    if "any_of" in item:
        return re.search(item["any_of"], prompt, PATTERN_FLAGS) is not None
    word = bool(item.get("word", False))
    return any(term_matches(term, normalized, word=word) for term in item["any_terms"])


def _lines(prompt: str) -> list[str]:
    """The prompt's lines: only a line feed ends a line, and a carriage return directly before it belongs to it."""
    pieces = prompt.split("\n")
    return [
        piece[:-1] if index < len(pieces) - 1 and piece.endswith("\r") else piece for index, piece in enumerate(pieces)
    ]


def _without_dialogue(text: str) -> str:
    """Every ``<d>`` and the text up to the next ``</d>`` (or to the end) as one space: spoken lines are not drawn."""
    out: list[str] = []
    start = 0
    while True:
        opened = text.find(DIALOGUE_OPEN, start)
        if opened < 0:
            out.append(text[start:])
            return "".join(out)
        out.append(text[start:opened])
        out.append(" ")
        closed = text.find(DIALOGUE_CLOSE, opened + len(DIALOGUE_OPEN))
        if closed < 0:
            return "".join(out)
        start = closed + len(DIALOGUE_CLOSE)


def scan_shots(prompt: str) -> tuple[list[int], list[tuple[int, str]]]:
    """The subjects ``subject_definitions`` defines and the text of every shot ("Evaluating rules").

    A line that starts with a field name and a colon starts that field. When the prompt has such a line, only the
    ``detailed_description`` and ``integrated_multimodal_description`` fields describe shots; otherwise the whole
    prompt does. There, every shot marker starts a shot, which runs to the next marker, a line of only spaces and
    tabs, or the next field. A shot's text is everything after its markers (a shot written in several spans is one
    shot), without dialogue. A subject is defined by a line of ``subject_definitions`` that starts with its tag.
    Subjects and shots come in the order they first appear.
    """
    lines = _lines(prompt)
    headings = [FIELD_HEADING.match(line) for line in lines]
    sectioned = any(heading is not None for heading in headings)
    field: str | None = None
    current: int | None = None
    shots: dict[int, list[str]] = {}
    subjects: list[int] = []
    for line, heading in zip(lines, headings, strict=True):
        content = line
        if heading is not None:
            field = heading.group(1)
            content = line[heading.end() :]
            current = None
        if field == "subject_definitions":
            defined = SUBJECT_TAG.match(content.lstrip(" \t"))
            if defined is not None and int(defined.group(1)) not in subjects:
                subjects.append(int(defined.group(1)))
        if (sectioned and field not in DESCRIPTION_FIELDS) or not content.strip(" \t"):
            current = None
            continue
        markers = list(SHOT_MARKER.finditer(content))
        if current is not None:
            shots[current].append(content[: markers[0].start()] if markers else content)
        for index, marker in enumerate(markers):
            end = markers[index + 1].start() if index + 1 < len(markers) else len(content)
            current = int(marker.group(1))
            shots.setdefault(current, []).append(content[marker.end() : end])
    return subjects, [(number, _without_dialogue("\n".join(parts))) for number, parts in shots.items()]


def _shot_findings(ref: str, checks: Mapping[str, Any], prompt: str) -> tuple[list[Finding], list[Finding]]:
    """``(forbidden, missing)`` of a rule's per-shot checks: shot by shot, forbid items before require items, then
    every defined subject that no shot names."""
    subjects, shots = scan_shots(prompt)
    forbidden: list[Finding] = []
    missing: list[Finding] = []
    named: set[int] = set()
    for number, text in shots:
        normalized = normalize(text)
        tags = {int(found.group(1)) for found in SUBJECT_TAG.finditer(text)}
        named |= tags
        for item in checks.get("forbid") or []:
            match = _forbidden_match(item, text, normalized)
            if match is not None:
                forbidden.append({"ref": ref, "check": item["id"], "match": match, "shot": number})
        if tags:
            missing += [
                {"ref": ref, "check": item["id"], "shot": number}
                for item in checks.get("require") or []
                if not _satisfied(item, text, normalized)
            ]
    every = checks.get("every_subject")
    if every is not None:
        missing += [{"ref": ref, "check": every["id"], "subject": number} for number in subjects if number not in named]
    return forbidden, missing


def inject_text(prompt: str, blocks: Sequence[str]) -> str:
    """Add the blocks the prompt does not contain yet, right after the ``detailed_description:`` line.

    Only a line feed ends a line; a carriage return directly before that line feed belongs to the line break. Without
    such a line the text goes to the very start, followed by an empty line.
    """
    missing = [block.strip() for block in blocks if block.strip() and block.strip() not in prompt]
    if not missing:
        return prompt
    text = "\n".join(missing)
    start = 0
    while start <= len(prompt):
        feed = prompt.find("\n", start)
        line_end = len(prompt) if feed < 0 else feed
        content_end = line_end - 1 if feed > start and prompt[feed - 1] == "\r" else line_end
        line = prompt[start:content_end]
        if line.startswith(DETAILED) and not line[len(DETAILED) :].strip(" \t"):
            return f"{prompt[:content_end]}\n{text}{prompt[content_end:]}"
        start = line_end + 1
    return f"{text}\n\n{prompt}"


def _index(registry: Mapping[str, Any]) -> tuple[dict[str, tuple[Any, Any, str]], dict[str, Any]]:
    """``ref -> (package, contribution, "rule" | "generation")`` and ``plugin_id -> package``."""
    contributions: dict[str, tuple[Any, Any, str]] = {}
    packages: dict[str, Any] = {}
    for package in registry["items"]:
        packages[package["plugin_id"]] = package
        for entry in package["contributes"]["rules"]:
            contributions[entry["ref"]] = (package, entry["rule"], "rule")
        for entry in package["contributes"]["generation"]:
            contributions[entry["ref"]] = (package, entry["generation"], "generation")
    return contributions, packages


def _reference_problem(ref: str, package: Mapping[str, Any] | None) -> Finding | None:
    """Why a reference cannot be used: nothing provides it, or its package is not ``ok``."""
    if package is None:
        return {"code": "unknown", "ref": ref}
    if package["status"] != "ok":
        return {"code": f"plugin_{package['status']}", "ref": ref, "plugin_id": package["plugin_id"]}
    return None


def _resolve(
    registry: Mapping[str, Any], refs: Sequence[str]
) -> tuple[list[tuple[str, Any]], list[tuple[str, Any]], list[Finding]]:
    """The accepted rules and generation settings in project order, and the references that are refused."""
    contributions, packages = _index(registry)
    rules: list[tuple[str, Any]] = []
    generation: list[tuple[str, Any]] = []
    problems: list[Finding] = []
    groups: dict[str, str] = {}
    for ref in refs:
        package, contribution, kind = contributions.get(ref, (packages.get(ref.rpartition("/")[0]), None, ""))
        problem = _reference_problem(ref, package)
        if problem is None and contribution is None:
            problem = {"code": "unknown", "ref": ref}
        group = contribution.get("group") if problem is None and kind == "rule" else None
        if group is not None and group in groups:
            problem = {"code": "group_conflict", "ref": ref, "group": group, "other": groups[group]}
        if problem is not None:
            problems.append(problem)
        elif kind == "rule":
            rules.append((ref, contribution))
            if group is not None:
                groups[group] = ref
        else:
            generation.append((ref, contribution))
    return rules, generation, problems


def _requirement_met(item: Mapping[str, Any], settings: Mapping[str, Any]) -> bool:
    """A requirement holds when the value the shot renders with is one of ``in``; an unknown value never is."""
    actual = settings.get(item["field"])
    return actual is not None and any(actual == allowed for allowed in item["in"])


def evaluate(
    registry: Mapping[str, Any] | None,
    refs: Sequence[str],
    prompt: str,
    settings: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply a project's selected contributions to one shot (see the module docstring for the result)."""
    result: dict[str, Any] = {"problems": [], "forbidden": [], "missing": [], "unmet": [], "prompt": prompt}
    if refs and registry is None:
        result["problems"].append({"code": "registry_unavailable"})
    elif refs and registry is not None:
        rules, generation, result["problems"] = _resolve(registry, refs)
        injected = [str(rule.get("inject") or "").strip() for _, rule in rules]
        size = sum(len(block.encode("utf-8")) for block in injected)
        limit = int(registry["limits"]["max_project_inject_bytes"])
        if size > limit:
            result["problems"].append({"code": "inject_too_large", "bytes": size, "limit": limit})
        normalized = normalize(prompt)
        for ref, rule in rules:
            for item in rule.get("forbid") or []:
                match = _forbidden_match(item, prompt, normalized)
                if match is not None:
                    result["forbidden"].append({"ref": ref, "check": item["id"], "match": match})
            result["missing"] += [
                {"ref": ref, "check": item["id"]}
                for item in rule.get("require") or []
                if not _satisfied(item, prompt, normalized)
            ]
            if rule.get("shots"):
                forbidden, missing = _shot_findings(ref, rule["shots"], prompt)
                result["forbidden"] += forbidden
                result["missing"] += missing
        ordered = sorted(rules, key=lambda pair: KIND_RANK[pair[1]["kind"]])
        result["prompt"] = inject_text(prompt, [str(rule.get("inject") or "") for _, rule in ordered])
        if settings is not None:
            result["unmet"] = [
                {"ref": ref, "check": item["id"]}
                for ref, setting in generation
                for item in setting.get("require") or []
                if not _requirement_met(item, settings)
            ]
    result["blocked"] = any(result[key] for key in ("problems", "forbidden", "missing", "unmet"))
    return result


__all__ = ["evaluate", "inject_text", "normalize", "scan_shots", "term_matches"]
