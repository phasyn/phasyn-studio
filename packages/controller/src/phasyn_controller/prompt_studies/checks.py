"""Integrity rules of a prompt study beyond its contract (what a transactional database would guarantee).

- The language and the source image are fixed once created; crops change only while there are no versions
  and no tasks.
- Versions are append-only: a saved version is never changed, deleted or reordered; ``number`` runs 1..n;
  candidates must be this scene's compile result (scene_sha256, prompt_sha256, language and intentional changes
  all match); intentional changes only touch locked sections.
- Tasks are never deleted or reordered; a terminal task (succeeded, failed, cancelled, interrupted) never
  changes; a running task keeps its kind, request, base_version_id and created_at. A reconstruction never
  renders more images or makes more vision calls than its budget.
- An accepted candidate must have been rendered successfully by a finished task; an archived study gets no
  new versions or tasks, and a study with a running task cannot be archived.

A conflict with what is stored → 409 STATE_CONFLICT (``check_transition``); an invalid document → 422
INVALID_ARGUMENT (``check_semantics``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError

SECTION_KEYS = ("subject", "action", "composition", "environment", "lighting", "appearance", "style", "visible_text")
TERMINAL_TASK_STATES = frozenset({"succeeded", "failed", "cancelled", "interrupted"})
UNCHECKED = "unchecked"  # PromptCandidate.token_status：CPU 編譯未檢查 token 數


def invalid(message: str, **details: Any) -> ComponentError:
    return ComponentError("INVALID_ARGUMENT", message, details=details or None)


def conflict(message: str, **details: Any) -> ComponentError:
    return ComponentError("STATE_CONFLICT", message, details=details or None)


def scene_problems(scene: Mapping[str, Any], *, views: set[str] | None = None) -> list[str]:
    """場景的結構完整性（不重做 vision 的證據規則）：subject 非空、observation id 唯一、引用同區段、視圖存在。"""
    problems: list[str] = []
    language = scene["prompt_language"]
    field = "text_zh_tw" if language == "zh-TW" else "text_en"
    if not str(scene["sections"]["subject"][field]).strip():
        problems.append(f"subject 的 {field} 不可空白")
    observations = {item["id"]: item for item in scene["observations"]}
    if len(observations) != len(scene["observations"]):
        problems.append("observation id 不得重複")
    for key in SECTION_KEYS:
        for observation_id in scene["sections"][key]["observation_ids"]:
            observation = observations.get(observation_id)
            if observation is None:
                problems.append(f"{key} 引用不存在的 observation {observation_id}")
            elif observation["section"] != key:
                problems.append(f"{key} 引用了屬於 {observation['section']} 的 observation {observation_id}")
    if views is not None:
        stray = sorted({item["view_id"] for item in scene["observations"]} - views)
        if stray:
            problems.append(f"observation 引用研究沒有的視圖 {', '.join(stray)}")
    return problems


def _check_candidates(version: Mapping[str, Any], language: str) -> list[str]:
    candidates = version["candidates"]
    problems: list[str] = []
    if candidates["language"] != language:
        problems.append(f"candidates 語言 {candidates['language']} 與研究語言 {language} 不同")
    if candidates["scene_sha256"] != digest(version["scene"]):
        problems.append("candidates.scene_sha256 與版本的 scene 不符（不是這個場景的編譯結果）")
    if set(candidates["intentional_changes"]) != set(version["intentional_changes"]):
        problems.append("candidates 的有意修改與版本不同")
    variants = [item["variant"] for item in candidates["items"]]
    if variants != ["core", "detailed"]:
        problems.append(f"candidates 必須依序是 core、detailed（收到 {variants}）")
    for item in candidates["items"]:
        if hashlib.sha256(str(item["prompt"]).encode("utf-8")).hexdigest() != item["prompt_sha256"]:
            problems.append(f"{item['variant']} 的 prompt_sha256 不符合內容")
        unchecked = item["token_status"] == UNCHECKED
        if unchecked != (item["target_tokens"] is None):
            problems.append(f"{item['variant']}：未檢查的 token 數必須是 null，已檢查必須有實際數值")
    hashes = [item["prompt_sha256"] for item in candidates["items"]]
    if len(hashes) == 2 and candidates["identical"] != (hashes[0] == hashes[1]):
        problems.append("candidates.identical 與 core／detailed 內容不一致")
    return problems


def _vision_operations(task: Mapping[str, Any]) -> int:
    count = 0
    for ref in task.get("result_refs") or []:
        kind = ref.get("kind")
        if kind in ("caption", "evaluation"):
            count += 1
        elif kind == "pairwise":
            count += 2
        elif kind == "version" and ref.get("run_id") is not None and task.get("kind") in ("refine", "reconstruct"):
            count += 1
    return count


def _check_task(task: Mapping[str, Any], versions: Mapping[str, Mapping[str, Any]]) -> list[str]:
    problems: list[str] = []
    tid = task["task_id"]
    request = task["request"]
    if request["kind"] != task["kind"]:
        problems.append(f"任務 {tid} 的 request.kind {request['kind']} 與 kind {task['kind']} 不同")
    if task["base_version_id"] is not None and task["base_version_id"] not in versions:
        problems.append(f"任務 {tid} 的 base_version_id {task['base_version_id']} 不存在")
    if task["kind"] != "analyze" and task["base_version_id"] is None:
        problems.append(f"任務 {tid}（{task['kind']}）需要 base_version_id")
    if (task["state"] in TERMINAL_TASK_STATES) != (task["finished_at"] is not None):
        problems.append(f"任務 {tid}：終態必須有 finished_at，執行中不可有")
    for ref in task["result_refs"]:
        for version_id in (
            ref.get("version_id"),
            (ref.get("incumbent") or {}).get("version_id"),
            (ref.get("challenger") or {}).get("version_id"),
        ):
            if version_id is not None and version_id not in versions:
                problems.append(f"任務 {tid} 的結果引用不存在的版本 {version_id}")
    if task["best"] is not None and task["best"]["version_id"] not in versions:
        problems.append(f"任務 {tid} 的 best 引用不存在的版本")
    renders = sum(1 for ref in task["result_refs"] if ref["kind"] == "render")
    if request["kind"] == "render" and renders > len(request["variants"]) * len(request["seeds"]):
        problems.append(f"任務 {tid} 的生成數 {renders} 超過要求的 variants×seeds")
    if request["kind"] == "reconstruct":
        search, holdout = set(request["search_seeds"]), set(request["holdout_seeds"])
        if search & holdout:
            problems.append(f"任務 {tid}：搜尋與 holdout seeds 不可重疊")
        required = 2 * len(search) * int(request["max_rounds"]) + 2 * len(holdout)
        if int(request["max_images"]) < required:
            problems.append(f"任務 {tid}：本次設定最多需要 {required} 張圖片預算（max_images={request['max_images']}）")
        if renders > int(request["max_images"]):
            problems.append(
                f"任務 {tid} 已生成 {renders} 張，超過預算 {request['max_images']}（失敗／取消的生成也計入）"
            )
        operations = _vision_operations(task)
        if operations > int(request["max_vision_operations"]):
            problems.append(f"任務 {tid} 的 vision 呼叫 {operations} 次，超過上限 {request['max_vision_operations']}")
    return problems


def _accepted_candidate_rendered(doc: Mapping[str, Any], versions: Mapping[str, Mapping[str, Any]]) -> str | None:
    """接受的候選必須在指定的已結束任務中實際生成成功（相同 prompt 的其他版本也算：相同 prompt 視為同一候選的 alias 規則）。"""
    acceptance = doc["acceptance"]
    version = versions[doc["accepted_version_id"]]
    task = next((item for item in doc["tasks"] if item["task_id"] == acceptance["task_id"]), None)
    if task is None:
        return f"acceptance.task_id {acceptance['task_id']} 不存在"
    if task["state"] not in TERMINAL_TASK_STATES:
        return "只能接受已結束任務的實際生成結果"
    target = next(
        item["prompt_sha256"] for item in version["candidates"]["items"] if item["variant"] == acceptance["variant"]
    )
    for ref in task["result_refs"]:
        if ref["kind"] != "render" or ref["state"] != "succeeded" or ref["version_id"] not in versions:
            continue
        if acceptance["run_id"] is not None and ref["run_id"] != acceptance["run_id"]:
            continue
        rendered = versions[ref["version_id"]]["candidates"]["items"]
        if any(item["variant"] == ref["variant"] and item["prompt_sha256"] == target for item in rendered):
            return None
    return "此候選在該任務中沒有成功的生成圖片，不能標記為已接受"


def check_semantics(doc: Mapping[str, Any]) -> None:
    """契約以外的完整性規則（呼叫端已驗證契約）。"""
    problems: list[str] = []
    language = doc["language"]
    crops = doc["crops"]
    if len({crop["view_id"] for crop in crops}) != len(crops):
        problems.append("裁切 view_id 不得重複")
    width, height = doc["source"]["width"], doc["source"]["height"]
    for crop in crops:
        if not (crop["x0"] < crop["x1"] and crop["y0"] < crop["y1"]):
            problems.append(f"裁切 {crop['view_id']} 需符合 x0<x1、y0<y1")
        elif width and height:
            pixels = (
                int(crop["x1"] * width) - int(crop["x0"] * width),
                int(crop["y1"] * height) - int(crop["y0"] * height),
            )
            if min(pixels) < 32:
                problems.append(f"裁切 {crop['view_id']} 只有 {pixels[0]}×{pixels[1]} 像素，至少需要 32×32")
    views = {"v-full", *(crop["view_id"] for crop in crops)}
    versions: dict[str, Mapping[str, Any]] = {}
    for index, version in enumerate(doc["versions"], start=1):
        vid = version["version_id"]
        if vid in versions:
            problems.append(f"version_id {vid} 重複")
        if version["number"] != index:
            problems.append(f"版本 {vid} 的 number 應為 {index}（依序遞增）")
        parent = version["parent_version_id"]
        if parent is not None and parent not in versions:
            problems.append(f"版本 {vid} 的 parent_version_id {parent} 不是較早的版本")
        if version["origin"] == "analysis" and parent is not None:
            problems.append(f"分析版本 {vid} 不可有 parent")
        if version["origin"] != "analysis" and parent is None:
            problems.append(f"{version['origin']} 版本 {vid} 需要 parent_version_id")
        scene = version["scene"]
        if scene["prompt_language"] != language:
            problems.append(f"版本 {vid} 的場景語言與研究語言 {language} 不同")
        problems.extend(f"版本 {vid}：{item}" for item in scene_problems(scene, views=views))
        unlocked = [key for key in version["intentional_changes"] if not scene["sections"][key]["locked"]]
        if unlocked:
            problems.append(f"版本 {vid} 的有意修改 {', '.join(unlocked)} 必須是鎖定區段")
        problems.extend(f"版本 {vid}：{item}" for item in _check_candidates(version, language))
        versions[vid] = version
    task_ids: set[str] = set()
    for task in doc["tasks"]:
        if task["task_id"] in task_ids:
            problems.append(f"task_id {task['task_id']} 重複")
        task_ids.add(task["task_id"])
        problems.extend(_check_task(task, versions))
    accepted = doc["accepted_version_id"]
    if (accepted is None) != (doc["acceptance"] is None):
        problems.append("accepted_version_id 與 acceptance 必須同時存在或同時為 null")
    elif accepted is not None:
        if accepted not in versions:
            problems.append(f"accepted_version_id {accepted} 不存在")
        else:
            reason = _accepted_candidate_rendered(doc, versions)
            if reason:
                problems.append(reason)
    if problems:
        raise invalid(f"反推研究不合法：{problems[0]}", errors=problems[:20])


def check_transition(stored: Mapping[str, Any], doc: Mapping[str, Any]) -> None:
    """與已保存內容的衝突（append-only／終態不可改／不可換原圖與語言）→ 409 STATE_CONFLICT。"""
    if doc["language"] != stored["language"]:
        raise conflict("研究語言建立後不可更換（版本與評分都綁定語言）")
    if doc["source"] != stored["source"]:
        raise conflict("研究原圖建立後不可更換；請建立新的研究")
    if doc["crops"] != stored["crops"] and (stored["versions"] or stored["tasks"]):
        raise conflict("已有版本或任務時不可修改裁切（證據引用這些視圖）")
    old_versions = stored["versions"]
    for index, old in enumerate(old_versions):
        if index >= len(doc["versions"]) or doc["versions"][index] != old:
            raise conflict(
                f"已保存的版本 {old['version_id']} 不可修改、刪除或重排；請新增版本", version_id=old["version_id"]
            )
    new_tasks = {task["task_id"]: task for task in doc["tasks"]}
    if [task["task_id"] for task in doc["tasks"][: len(stored["tasks"])]] != [
        task["task_id"] for task in stored["tasks"]
    ]:
        missing = sorted({task["task_id"] for task in stored["tasks"]} - set(new_tasks))
        raise conflict("任務紀錄不可刪除或重排", missing_task_ids=missing)
    for old in stored["tasks"]:
        new = new_tasks[old["task_id"]]
        if old["state"] in TERMINAL_TASK_STATES and new != old:
            raise conflict(f"任務 {old['task_id']} 已結束（{old['state']}），不可再修改", task_id=old["task_id"])
        for field in ("kind", "request", "base_version_id", "created_at"):
            if new[field] != old[field]:
                raise conflict(f"任務 {old['task_id']} 的 {field} 建立後不可修改", task_id=old["task_id"])
    if (
        stored["archived"]
        and doc["archived"]
        and (len(doc["versions"]) != len(old_versions) or len(doc["tasks"]) != len(stored["tasks"]))
    ):
        raise conflict("已封存的研究不能新增版本或任務；請先取消封存")
    if doc["archived"] and not stored["archived"]:
        running = [task["task_id"] for task in doc["tasks"] if task["state"] == "running"]
        if running:
            raise conflict("有執行中的任務時不能封存；請先停止或標記為已中斷", running_task_ids=running)


__all__ = [
    "SECTION_KEYS",
    "TERMINAL_TASK_STATES",
    "check_semantics",
    "check_transition",
    "conflict",
    "invalid",
    "scene_problems",
]
