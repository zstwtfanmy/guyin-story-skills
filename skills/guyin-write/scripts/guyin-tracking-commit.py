#!/usr/bin/env python3
"""Maintain one structured story state and its deterministic Markdown views.

The language model supplies compact semantic JSON.  This tool validates and
merges that input in memory, renders every derived view, then atomically writes
``_tracking-state.json`` last as the single commit point.  One book project has
one serial writer; concurrent commits are intentionally unsupported.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import stat
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any


INPUT_SCHEMA_VERSION = 1
TRACKING_SCHEMA_VERSION = 7
# v5 新增 verdicts（G2 事件定性实体）；v6 新增 evidence（T1 物证实体）与 geo（T2 地理
# 实体）；v7 新增 scenes（P4 场景台账实体）；读入仍接受 v4/v5/v6（缺键视为空），写盘
# 统一 v7，存量项目无需手工迁移——下一次 commit/backfill 即自动升级。
SUPPORTED_STATE_VERSIONS = (4, 5, 6, 7)
DELTA_TARGET_BYTES = 1536
DELTA_MAX_BYTES = 3072
CONTEXT_TARGET_BYTES = 8192
CONTEXT_MAX_BYTES = 12288
SNAPSHOT_TARGET_BYTES = 4096
SNAPSHOT_MAX_BYTES = 8192

CONTEXT_HEADINGS = (
    "## 当前位置",
    "## 长期约束",
    "## 核心角色状态",
    "## 活跃伏笔",
    "## 近三章速记",
    "## 下一章承诺",
    "## 连贯性风险",
)
FORESHADOW_STATUSES = ("已埋", "已回收", "已过期", "放弃")
FORESHADOW_IMPORTANCE = ("高", "中", "低")
# Z2 揭示方式（可选）：长篇连线距离最远、当量要求最高——比短篇反转表少一列的倒挂修正。
# 一句带过 / 慢镜头 / 当场短路——管「够不够爽」的怎么响，不是够不够爽本身（红楼梦「你放心」= 压的长度 × 揭示的克制）。
FORESHADOW_REVEAL_METHODS = ("一句带过", "慢镜头", "当场短路")
REVEAL_STATUSES = ("未揭示", "部分揭示", "已揭示")
# G2 事件定性实体：高潮/爽点章兑付给读者的叙事资产。status 供收线审计（P3）与完书复盘消费。
VERDICT_STATUSES = ("active", "repriced", "nullified")
# T1 物证实体：查案物证登记链。anchor 存正文原句（禁概括），keywords 供
# guyin-check-consistency.js 空降检测（未登记物证突然出现在结论里）。
EVIDENCE_STATUSES = ("held", "transferred", "destroyed", "archived")
EVIDENCE_STATUS_LABELS = {"held": "在案", "transferred": "流转", "destroyed": "销毁", "archived": "归档"}
# T2 地理实体：规范名+别名+相对方位断言（本名 在 参照地 以方向）。断言存正文原句，
# 供 guyin-check-consistency.js 方向冲突/行程连续性检测；无参照地的仅做新地名登记。
GEO_DIRECTIONS = ("东", "南", "西", "北", "东北", "东南", "西北", "西南")
# P4 场景台账实体：场景状态与角色状态同构——五感锚点/布局事实存正文原句（禁概括），
# 低模型补全具体名词的能力远强于从抽象生成具体；keywords 供场景漂移检测。
SCENE_STATUSES = ("active", "changed", "destroyed")
SCENE_STATUS_LABELS = {"active": "在场", "changed": "已变迁", "destroyed": "已毁"}
INVALID_FILE_CHARS = re.compile(r"[<>:\"/\\|?*\x00-\x1f]")
FORESHADOW_ID = re.compile(r"^F\d{3,}$")
EVENT_ID = re.compile(r"^E\d{3,}$")
VERDICT_ID = re.compile(r"^V\d{3,}$")
EVIDENCE_ID = re.compile(r"^W\d{3,}$")
GEO_ID = re.compile(r"^G\d{3,}$")
SCENE_ID = re.compile(r"^S\d{3,}$")
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
RETIRED_TRACKING_PATHS = (
    "_tracking-meta.json",
    "阶段摘要.md",
    "角色状态.md",
    "时间线.md",
    "摘要",
    "时间线/事件库.json",
)
RETIRED_ARCHIVE_DIR = "_旧追踪存档"


class TrackingError(ValueError):
    """Expected validation or tracking-state error."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TrackingError(message)


def as_mapping(value: object, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def as_list(value: object, label: str) -> list[Any]:
    require(isinstance(value, list), f"{label} must be a JSON array")
    return value


def as_int(value: object, label: str, *, minimum: int = 0) -> int:
    require(isinstance(value, int) and not isinstance(value, bool), f"{label} must be an integer")
    require(value >= minimum, f"{label} must be >= {minimum}")
    return value


def require_known_keys(mapping: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(mapping) - allowed
    require(not unknown, f"{label} contains unsupported fields: {', '.join(sorted(unknown))}")


def clean_text(value: object, label: str, *, allow_empty: bool = False, max_bytes: int = 768) -> str:
    require(isinstance(value, str), f"{label} must be a string")
    cleaned = " ".join(value.replace("|", "｜").split())
    require(allow_empty or bool(cleaned), f"{label} must not be empty")
    require(len(cleaned.encode("utf-8")) <= max_bytes, f"{label} exceeds {max_bytes} bytes")
    return cleaned


def clean_string_list(
    value: object,
    label: str,
    *,
    maximum: int | None = None,
    item_max_bytes: int = 384,
) -> list[str]:
    values = as_list(value, label)
    if maximum is not None:
        require(len(values) <= maximum, f"{label} may contain at most {maximum} items")
    return [clean_text(item, f"{label}[{index}]", max_bytes=item_max_bytes) for index, item in enumerate(values)]


def safe_file_component(value: object, label: str) -> str:
    name = unicodedata.normalize("NFC", clean_text(value, label, max_bytes=180))
    require(not INVALID_FILE_CHARS.search(name), f"{label} contains an invalid filename character")
    require(name not in {".", ".."} and not name.endswith((".", " ")), f"{label} is not a safe filename")
    require(name.split(".", 1)[0].upper() not in WINDOWS_RESERVED_NAMES, f"{label} is reserved on Windows")
    return name


def portable_name_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def byte_size(text: str) -> int:
    return len(text.encode("utf-8"))


def emit(text: str, *, error: bool = False) -> None:
    """Write UTF-8 bytes directly.

    Windows 的文本 stdout 是 cp1252（含中文即 UnicodeEncodeError），stderr 默认
    backslashreplace（中文被转义成反斜杠码位，作者看不懂）。两条路都要绕开。
    """
    stream = sys.stderr if error else sys.stdout
    stream.flush()
    stream.buffer.write((text + "\n").encode("utf-8"))
    stream.buffer.flush()


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TrackingError(f"unable to read JSON {path}: {exc}") from exc


def json_payload(document: object) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def atomic_write_text(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_if_changed(path: Path, payload: str) -> None:
    try:
        if path.read_text(encoding="utf-8") == payload:
            return
    except FileNotFoundError:
        pass
    atomic_write_text(path, payload)


def tracking_root(project: Path) -> Path:
    return project.resolve() / "追踪"


def state_path(project: Path) -> Path:
    return tracking_root(project) / "_tracking-state.json"


def delta_path(tracking: Path, chapter: int) -> Path:
    width = max(3, len(str(chapter)))
    return tracking / "逐章记录" / f"第{chapter:0{width}d}章.md"


def find_retired_tracking_paths(tracking: Path) -> list[str]:
    found = [relative for relative in RETIRED_TRACKING_PATHS if (tracking / relative).exists()]
    found.extend(sorted(path.name for path in tracking.glob("基线_截至第*章.md")))
    return found


def require_no_retired_tracking_paths(tracking: Path) -> None:
    found = find_retired_tracking_paths(tracking)
    require(not found, f"retired tracking files are not supported: {', '.join(found)}")


def archive_retired_tracking_paths(tracking: Path) -> list[str]:
    """Move a pre-transaction 追踪/ aside so init can build the current protocol in place.

    Nothing is parsed or converted: the old files are kept verbatim for the author to
    consult, and the new state is reconstructed from the init document alone.
    """
    retired = find_retired_tracking_paths(tracking)
    if not retired:
        return []
    archive = tracking / RETIRED_ARCHIVE_DIR
    for relative in retired:
        require(
            not (archive / relative).exists(),
            f"追踪/{RETIRED_ARCHIVE_DIR}/{relative} already exists; move it away before initializing",
        )
    # 先全量校验再搬运；中断后重跑时已搬走的条目不再出现在待搬列表里，可直接续做。
    for relative in retired:
        target = archive / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tracking / relative, target)
    return retired


def validate_position(value: object, label: str = "context.position") -> dict[str, Any]:
    position = as_mapping(value, label)
    require_known_keys(position, {"volume", "volume_start_chapter", "story_time", "scene"}, label)
    return {
        "volume": safe_file_component(position.get("volume"), f"{label}.volume"),
        "volume_start_chapter": as_int(
            position.get("volume_start_chapter"), f"{label}.volume_start_chapter", minimum=1
        ),
        "story_time": clean_text(position.get("story_time"), f"{label}.story_time", max_bytes=240),
        "scene": clean_text(position.get("scene"), f"{label}.scene", max_bytes=240),
    }


def normalize_snapshot(value: object, label: str) -> dict[str, Any]:
    snapshot = as_mapping(value, label)
    require_known_keys(
        snapshot,
        {"identity", "location", "goal", "state", "abilities_resources", "relationships", "knowledge", "open_threads"},
        label,
    )
    return {
        "identity": clean_text(snapshot.get("identity"), f"{label}.identity", max_bytes=240),
        "location": clean_text(snapshot.get("location"), f"{label}.location", max_bytes=240),
        "goal": clean_text(snapshot.get("goal"), f"{label}.goal", max_bytes=300),
        "state": clean_text(snapshot.get("state"), f"{label}.state", max_bytes=300),
        "abilities_resources": clean_string_list(
            snapshot.get("abilities_resources", []), f"{label}.abilities_resources"
        ),
        "relationships": clean_string_list(snapshot.get("relationships", []), f"{label}.relationships"),
        "knowledge": clean_string_list(snapshot.get("knowledge", []), f"{label}.knowledge"),
        "open_threads": clean_string_list(snapshot.get("open_threads", []), f"{label}.open_threads"),
    }


def normalize_snapshots(value: object, label: str = "character_snapshots") -> dict[str, dict[str, Any]]:
    snapshots = as_mapping(value, label)
    normalized: dict[str, dict[str, Any]] = {}
    portable_names: set[str] = set()
    for raw_name, raw_snapshot in snapshots.items():
        name = safe_file_component(raw_name, f"{label} character name")
        key = portable_name_key(name)
        require(key not in portable_names, f"{label} contains a cross-platform duplicate character {name}")
        portable_names.add(key)
        normalized[name] = normalize_snapshot(raw_snapshot, f"{label}.{name}")
    return normalized


def render_snapshot(name: str, snapshot: dict[str, Any], through_chapter: int, revision: int) -> str:
    def section(title: str, values: list[str]) -> list[str]:
        return [f"## {title}", *(f"- {item}" for item in values or ["无"]), ""]

    lines = [
        f"# {name}｜当前状态",
        "",
        f"- 状态修订：{revision}",
        f"- 截至章节：第{through_chapter}章",
        f"- 身份：{snapshot['identity']}",
        f"- 位置：{snapshot['location']}",
        f"- 当前目标：{snapshot['goal']}",
        f"- 身心状态：{snapshot['state']}",
        "",
    ]
    lines.extend(section("能力与资源", snapshot["abilities_resources"]))
    lines.extend(section("关键关系", snapshot["relationships"]))
    lines.extend(section("已知信息", snapshot["knowledge"]))
    lines.extend(section("未结事项", snapshot["open_threads"]))
    payload = "\n".join(lines).rstrip() + "\n"
    require(
        byte_size(payload) <= SNAPSHOT_MAX_BYTES,
        f"character snapshot {name} exceeds hard cap of {SNAPSHOT_MAX_BYTES} bytes",
    )
    return payload


def normalize_foreshadow_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    row = as_mapping(value, label)
    require_known_keys(
        row,
        {"action", "id", "summary", "planted_chapter", "planned_resolution_chapter", "status", "importance", "reveal_method"},
        label,
    )
    action = clean_text(row.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(row.get("id"), f"{label}.id", max_bytes=24)
    require(FORESHADOW_ID.fullmatch(identifier) is not None, f"{label}.id must look like F001")
    if action == "delete":
        return {"action": action, "id": identifier}
    planted_chapter = as_int(row.get("planted_chapter"), f"{label}.planted_chapter", minimum=1)
    require(planted_chapter <= through_chapter, f"{label}.planted_chapter cannot be in the future")
    planned_raw = row.get("planned_resolution_chapter")
    planned_chapter = (
        None if planned_raw is None else as_int(planned_raw, f"{label}.planned_resolution_chapter", minimum=1)
    )
    require(
        planned_chapter is None or planned_chapter >= planted_chapter,
        f"{label}.planned_resolution_chapter cannot precede planted_chapter",
    )
    status = clean_text(row.get("status"), f"{label}.status", max_bytes=24)
    importance = clean_text(row.get("importance"), f"{label}.importance", max_bytes=12)
    require(status in FORESHADOW_STATUSES, f"{label}.status must be one of {FORESHADOW_STATUSES}")
    require(importance in FORESHADOW_IMPORTANCE, f"{label}.importance must be one of {FORESHADOW_IMPORTANCE}")
    # Z2 揭示方式（可选）：缺省 None（不写、存量空值不报错）；存在则必须三选一。
    reveal_raw = row.get("reveal_method")
    reveal_method = None
    if reveal_raw is not None:
        reveal_method = clean_text(reveal_raw, f"{label}.reveal_method", max_bytes=24)
        require(reveal_method in FORESHADOW_REVEAL_METHODS, f"{label}.reveal_method must be one of {FORESHADOW_REVEAL_METHODS}")
    return {
        "action": action,
        "id": identifier,
        "summary": clean_text(row.get("summary"), f"{label}.summary", max_bytes=360),
        "planted_chapter": planted_chapter,
        "planned_resolution_chapter": planned_chapter,
        "status": status,
        "importance": importance,
        "reveal_method": reveal_method,
    }


def normalize_foreshadow_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    rows = as_mapping(value, "tracking state.foreshadow")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_row in rows.items():
        identifier = clean_text(raw_identifier, "tracking state.foreshadow ID", max_bytes=24)
        row = as_mapping(raw_row, f"tracking state.foreshadow.{identifier}")
        require_known_keys(
            row,
            {"id", "summary", "planted_chapter", "planned_resolution_chapter", "status", "importance", "reveal_method", "updated_chapter"},
            f"tracking state.foreshadow.{identifier}",
        )
        require(row.get("id") == identifier, f"tracking state.foreshadow.{identifier}.id does not match its key")
        change = normalize_foreshadow_change(
            {
                "action": "upsert",
                **{key: value for key, value in row.items() if key != "updated_chapter"},
            },
            f"tracking state.foreshadow.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        updated = as_int(row.get("updated_chapter"), f"tracking state.foreshadow.{identifier}.updated_chapter", minimum=1)
        require(updated <= last_chapter, f"foreshadow {identifier} updates after current chapter")
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


def render_foreshadow(rows: dict[str, dict[str, Any]], revision: int) -> str:
    lines = [
        "# 伏笔当前状态",
        "",
        f"> 状态修订：{revision}。每个 ID 只保留一行当前状态；历史变化见 `逐章记录/`。",
        "",
        "| ID | 内容 | 埋设章 | 计划回收章 | 状态 | 重要度 | 揭示方式 | 最近变更章 |",
        "|---|---|---:|---:|---|---|---|---:|",
    ]
    for identifier in sorted(rows):
        row = rows[identifier]
        planned = f"第{row['planned_resolution_chapter']}章" if row["planned_resolution_chapter"] else "—"
        reveal = row.get("reveal_method") or "—"
        lines.append(
            f"| {identifier} | {row['summary']} | 第{row['planted_chapter']}章 | {planned} | "
            f"{row['status']} | {row['importance']} | {reveal} | 第{row['updated_chapter']}章 |"
        )
    return "\n".join(lines) + "\n"


def normalize_verdict_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    """G2 事件定性实体：verdict 存从正文摘出的定性句原文（禁概括）——
    低模型补全具体名词的能力远强于从抽象生成具体（与 P4 场景锚点同构）。"""
    row = as_mapping(value, label)
    require_known_keys(row, {"action", "id", "chapter", "event", "verdict", "status", "keywords"}, label)
    action = clean_text(row.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(row.get("id"), f"{label}.id", max_bytes=24)
    require(VERDICT_ID.fullmatch(identifier) is not None, f"{label}.id must look like V001")
    if action == "delete":
        return {"action": action, "id": identifier}
    chapter = as_int(row.get("chapter"), f"{label}.chapter", minimum=1)
    require(chapter <= through_chapter, f"{label}.chapter cannot be in the future")
    status = clean_text(row.get("status"), f"{label}.status", max_bytes=24)
    require(status in VERDICT_STATUSES, f"{label}.status must be one of {VERDICT_STATUSES}")
    keywords = clean_string_list(row.get("keywords", []), f"{label}.keywords", maximum=8, item_max_bytes=64)
    require(len(keywords) >= 1, f"{label}.keywords needs at least one anchor for narrative-asset checks")
    require(all(len(keyword) >= 2 for keyword in keywords), f"{label}.keywords items must be at least 2 characters")
    return {
        "action": action,
        "id": identifier,
        "chapter": chapter,
        "event": clean_text(row.get("event"), f"{label}.event", max_bytes=120),
        "verdict": clean_text(row.get("verdict"), f"{label}.verdict", max_bytes=480),
        "status": status,
        "keywords": keywords,
    }


def normalize_verdict_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    verdicts = as_mapping(value, "tracking state.verdicts")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_row in verdicts.items():
        identifier = clean_text(raw_identifier, "tracking state.verdicts ID", max_bytes=24)
        row = as_mapping(raw_row, f"tracking state.verdicts.{identifier}")
        require_known_keys(
            row,
            {"id", "chapter", "event", "verdict", "status", "keywords", "updated_chapter"},
            f"tracking state.verdicts.{identifier}",
        )
        require(row.get("id") == identifier, f"tracking state.verdicts.{identifier}.id does not match its key")
        change = normalize_verdict_change(
            {"action": "upsert", **{key: item for key, item in row.items() if key != "updated_chapter"}},
            f"tracking state.verdicts.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        updated = as_int(row.get("updated_chapter"), f"tracking state.verdicts.{identifier}.updated_chapter", minimum=1)
        require(updated <= last_chapter, f"verdict {identifier} updates after current chapter")
        require(updated >= change["chapter"], f"verdict {identifier} is updated before its own event chapter")
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


def render_verdict(rows: dict[str, dict[str, Any]], revision: int) -> str:
    lines = [
        "# 事件定性资产",
        "",
        f"> 状态修订：{revision}。已兑付给读者的叙事资产（高潮/爽点定性）：active=已兑付 / repriced=已重估（档1）/ nullified=已没收（档2）。没收与重估须过 G1 档位仲裁；本表只记事实，keywords 供 guyin-check-narrative-asset.js 共现检测。",
        "",
        "| ID | 事件 | 定性章 | 定性（正文原句，禁概括） | 状态 | 关键词 | 最近变更章 |",
        "|---|---|---:|---|---|---|---:|",
    ]
    for identifier in sorted(rows):
        row = rows[identifier]
        lines.append(
            f"| {identifier} | {row['event']} | 第{row['chapter']}章 | {row['verdict']} | "
            f"{row['status']} | {'、'.join(row['keywords'])} | 第{row['updated_chapter']}章 |"
        )
    return "\n".join(lines) + "\n"


def normalize_evidence_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    """T1 物证实体：anchor 存物证首次登场/获得的正文原句（禁概括）——与 verdicts
    同构（低模型补全具体名词的能力远强于从抽象生成具体）。"""
    row = as_mapping(value, label)
    require_known_keys(row, {"action", "id", "chapter", "name", "anchor", "status", "holder", "keywords"}, label)
    action = clean_text(row.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(row.get("id"), f"{label}.id", max_bytes=24)
    require(EVIDENCE_ID.fullmatch(identifier) is not None, f"{label}.id must look like W001")
    if action == "delete":
        return {"action": action, "id": identifier}
    chapter = as_int(row.get("chapter"), f"{label}.chapter", minimum=1)
    require(chapter <= through_chapter, f"{label}.chapter cannot be in the future")
    status = clean_text(row.get("status"), f"{label}.status", max_bytes=24)
    require(status in EVIDENCE_STATUSES, f"{label}.status must be one of {EVIDENCE_STATUSES}")
    keywords = clean_string_list(row.get("keywords", []), f"{label}.keywords", maximum=8, item_max_bytes=64)
    require(len(keywords) >= 1, f"{label}.keywords needs at least one anchor for consistency checks")
    require(all(len(keyword) >= 2 for keyword in keywords), f"{label}.keywords items must be at least 2 characters")
    return {
        "action": action,
        "id": identifier,
        "chapter": chapter,
        "name": clean_text(row.get("name"), f"{label}.name", max_bytes=120),
        "anchor": clean_text(row.get("anchor"), f"{label}.anchor", max_bytes=480),
        "status": status,
        "holder": clean_text(row.get("holder", ""), f"{label}.holder", allow_empty=True, max_bytes=120),
        "keywords": keywords,
    }


def normalize_evidence_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    evidence = as_mapping(value, "tracking state.evidence")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_row in evidence.items():
        identifier = clean_text(raw_identifier, "tracking state.evidence ID", max_bytes=24)
        row = as_mapping(raw_row, f"tracking state.evidence.{identifier}")
        require_known_keys(
            row,
            {"id", "chapter", "name", "anchor", "status", "holder", "keywords", "updated_chapter"},
            f"tracking state.evidence.{identifier}",
        )
        require(row.get("id") == identifier, f"tracking state.evidence.{identifier}.id does not match its key")
        change = normalize_evidence_change(
            {"action": "upsert", **{key: item for key, item in row.items() if key != "updated_chapter"}},
            f"tracking state.evidence.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        updated = as_int(row.get("updated_chapter"), f"tracking state.evidence.{identifier}.updated_chapter", minimum=1)
        require(updated <= last_chapter, f"evidence {identifier} updates after current chapter")
        require(updated >= change["chapter"], f"evidence {identifier} is updated before its own first chapter")
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


def render_evidence(rows: dict[str, dict[str, Any]], revision: int) -> str:
    lines = [
        "# 物证台账",
        "",
        f"> 状态修订：{revision}。查案物证登记链（T1）：锚点存正文原句（禁概括），keywords 供 guyin-check-consistency.js 空降检测；状态 held=在案 / transferred=流转 / destroyed=销毁 / archived=归档。",
        "",
        "| ID | 物证 | 登场章 | 锚点（正文原句，禁概括） | 状态 | 持有/所在 | 关键词 | 最近变更章 |",
        "|---|---|---:|---|---|---|---|---:|",
    ]
    for identifier in sorted(rows):
        row = rows[identifier]
        lines.append(
            f"| {identifier} | {row['name']} | 第{row['chapter']}章 | {row['anchor']} | "
            f"{EVIDENCE_STATUS_LABELS.get(row['status'], row['status'])} | {row['holder'] or '—'} | "
            f"{'、'.join(row['keywords'])} | 第{row['updated_chapter']}章 |"
        )
    return "\n".join(lines) + "\n"


def normalize_geo_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    """T2 地理实体：ref/direction 构成相对方位断言（本名 在 参照地 以方向）；ref 为
    空时仅做地名登记（新地名检测）。anchor 存断言/首次提及的正文原句（禁概括）。"""
    row = as_mapping(value, label)
    require_known_keys(row, {"action", "id", "chapter", "name", "aliases", "anchor", "ref", "direction", "keywords"}, label)
    action = clean_text(row.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(row.get("id"), f"{label}.id", max_bytes=24)
    require(GEO_ID.fullmatch(identifier) is not None, f"{label}.id must look like G001")
    if action == "delete":
        return {"action": action, "id": identifier}
    chapter = as_int(row.get("chapter"), f"{label}.chapter", minimum=1)
    require(chapter <= through_chapter, f"{label}.chapter cannot be in the future")
    raw_ref = row.get("ref")
    raw_direction = row.get("direction")
    if raw_ref is None:
        require(raw_direction is None, f"{label}.direction requires ref")
        ref: str | None = None
        direction: str | None = None
    else:
        ref = clean_text(raw_ref, f"{label}.ref", max_bytes=120)
        direction = clean_text(raw_direction, f"{label}.direction", max_bytes=8)
        require(direction in GEO_DIRECTIONS, f"{label}.direction must be one of {GEO_DIRECTIONS}")
    keywords = clean_string_list(row.get("keywords", []), f"{label}.keywords", maximum=8, item_max_bytes=64)
    require(len(keywords) >= 1, f"{label}.keywords needs at least one anchor for consistency checks")
    require(all(len(keyword) >= 2 for keyword in keywords), f"{label}.keywords items must be at least 2 characters")
    return {
        "action": action,
        "id": identifier,
        "chapter": chapter,
        "name": clean_text(row.get("name"), f"{label}.name", max_bytes=120),
        "aliases": clean_string_list(row.get("aliases", []), f"{label}.aliases", maximum=8, item_max_bytes=120),
        "anchor": clean_text(row.get("anchor"), f"{label}.anchor", max_bytes=480),
        "ref": ref,
        "direction": direction,
        "keywords": keywords,
    }


def normalize_geo_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    geo = as_mapping(value, "tracking state.geo")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_row in geo.items():
        identifier = clean_text(raw_identifier, "tracking state.geo ID", max_bytes=24)
        row = as_mapping(raw_row, f"tracking state.geo.{identifier}")
        require_known_keys(
            row,
            {"id", "chapter", "name", "aliases", "anchor", "ref", "direction", "keywords", "updated_chapter"},
            f"tracking state.geo.{identifier}",
        )
        require(row.get("id") == identifier, f"tracking state.geo.{identifier}.id does not match its key")
        change = normalize_geo_change(
            {"action": "upsert", **{key: item for key, item in row.items() if key != "updated_chapter"}},
            f"tracking state.geo.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        updated = as_int(row.get("updated_chapter"), f"tracking state.geo.{identifier}.updated_chapter", minimum=1)
        require(updated <= last_chapter, f"geo {identifier} updates after current chapter")
        require(updated >= change["chapter"], f"geo {identifier} is updated before its own first chapter")
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


# P2 章节金字塔：chapter_summaries 存全量章摘要（近三章速记是滚动窗口，此为持久层）。
# 编排层写完一章后由摘要卡（零温）生成 delta.result，commit 时自动入库。
def normalize_chapter_summaries(value: object, last_chapter: int) -> dict[str, str]:
    raw = as_mapping(value, "tracking state.chapter_summaries")
    normalized: dict[str, str] = {}
    for key, summary in raw.items():
        require(isinstance(key, str) and key.isdigit(), f"chapter_summaries key {key!r} must be a chapter number string")
        chapter = int(key)
        require(chapter >= 1, f"chapter_summaries key {key!r} must be >= 1")
        require(chapter <= last_chapter, f"chapter_summaries[{key}] exceeds last_committed_chapter")
        normalized[key] = clean_text(summary, f"chapter_summaries[{key}]", max_bytes=768)
    return normalized


def render_geo(rows: dict[str, dict[str, Any]], revision: int) -> str:
    lines = [
        "# 地理台账",
        "",
        f"> 状态修订：{revision}。地理实体登记（T2）：方位断言存正文原句（禁概括），「本名 在 参照地 以方向」供 guyin-check-consistency.js 方向冲突/行程连续性检测；相对为 — 的地点仅做新地名登记。",
        "",
        "| ID | 地名 | 别名 | 登场章 | 方位断言（正文原句，禁概括） | 相对 | 方向 | 关键词 | 最近变更章 |",
        "|---|---|---|---:|---|---|---|---|---:|",
    ]
    for identifier in sorted(rows):
        row = rows[identifier]
        lines.append(
            f"| {identifier} | {row['name']} | {'、'.join(row['aliases']) or '—'} | 第{row['chapter']}章 | "
            f"{row['anchor']} | {row['ref'] or '—'} | {row['direction'] or '—'} | "
            f"{'、'.join(row['keywords'])} | 第{row['updated_chapter']}章 |"
        )
    return "\n".join(lines) + "\n"


def normalize_scene_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    """P4 场景台账实体：anchor 存五感锚点/布局事实的正文原句（禁概括）——存「院里有棵
    歪脖枣树，树底下压着半扇磨盘」，不存「院子里有植物和农具」；current 存变迁后现状
    （「那场火之后西厢塌了」），anchor+current 构成状态变迁链。"""
    row = as_mapping(value, label)
    require_known_keys(row, {"action", "id", "chapter", "name", "anchor", "status", "current", "keywords"}, label)
    action = clean_text(row.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(row.get("id"), f"{label}.id", max_bytes=24)
    require(SCENE_ID.fullmatch(identifier) is not None, f"{label}.id must look like S001")
    if action == "delete":
        return {"action": action, "id": identifier}
    chapter = as_int(row.get("chapter"), f"{label}.chapter", minimum=1)
    require(chapter <= through_chapter, f"{label}.chapter cannot be in the future")
    status = clean_text(row.get("status"), f"{label}.status", max_bytes=24)
    require(status in SCENE_STATUSES, f"{label}.status must be one of {SCENE_STATUSES}")
    keywords = clean_string_list(row.get("keywords", []), f"{label}.keywords", maximum=8, item_max_bytes=64)
    require(len(keywords) >= 1, f"{label}.keywords needs at least one anchor for drift checks")
    require(all(len(keyword) >= 2 for keyword in keywords), f"{label}.keywords items must be at least 2 characters")
    return {
        "action": action,
        "id": identifier,
        "chapter": chapter,
        "name": clean_text(row.get("name"), f"{label}.name", max_bytes=120),
        "anchor": clean_text(row.get("anchor"), f"{label}.anchor", max_bytes=480),
        "status": status,
        "current": clean_text(row.get("current", ""), f"{label}.current", allow_empty=True, max_bytes=480),
        "keywords": keywords,
    }


def normalize_scene_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    scenes = as_mapping(value, "tracking state.scenes")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_row in scenes.items():
        identifier = clean_text(raw_identifier, "tracking state.scenes ID", max_bytes=24)
        row = as_mapping(raw_row, f"tracking state.scenes.{identifier}")
        require_known_keys(
            row,
            {"id", "chapter", "name", "anchor", "status", "current", "keywords", "updated_chapter"},
            f"tracking state.scenes.{identifier}",
        )
        require(row.get("id") == identifier, f"tracking state.scenes.{identifier}.id does not match its key")
        change = normalize_scene_change(
            {"action": "upsert", **{key: item for key, item in row.items() if key != "updated_chapter"}},
            f"tracking state.scenes.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        updated = as_int(row.get("updated_chapter"), f"tracking state.scenes.{identifier}.updated_chapter", minimum=1)
        require(updated <= last_chapter, f"scene {identifier} updates after current chapter")
        require(updated >= change["chapter"], f"scene {identifier} is updated before its own first chapter")
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


def render_scene(rows: dict[str, dict[str, Any]], revision: int) -> str:
    lines = [
        "# 场景台账",
        "",
        f"> 状态修订：{revision}。场景实体登记（P4）：五感锚点/布局事实存正文原句（禁概括），current 存变迁后现状——anchor+current 构成状态变迁链；keywords 供场景漂移检测（同场景再写时锚点物缺失即提示）。",
        "",
        "| ID | 场景 | 登场章 | 五感锚点（正文原句，禁概括） | 状态 | 现状/变迁 | 关键词 | 最近变更章 |",
        "|---|---|---:|---|---|---|---|---:|",
    ]
    for identifier in sorted(rows):
        row = rows[identifier]
        lines.append(
            f"| {identifier} | {row['name']} | 第{row['chapter']}章 | {row['anchor']} | "
            f"{SCENE_STATUS_LABELS.get(row['status'], row['status'])} | {row['current'] or '—'} | "
            f"{'、'.join(row['keywords'])} | 第{row['updated_chapter']}章 |"
        )
    return "\n".join(lines) + "\n"


def normalize_timeline_change(
    value: object,
    label: str,
    *,
    allow_delete: bool,
    through_chapter: int,
) -> dict[str, Any]:
    event = as_mapping(value, label)
    require_known_keys(
        event,
        {"action", "id", "story_time", "objective_fact", "reader_knowledge", "reveal_status", "reveal_chapter", "characters"},
        label,
    )
    action = clean_text(event.get("action", "upsert"), f"{label}.action", max_bytes=24)
    require(action in ({"upsert", "delete"} if allow_delete else {"upsert"}), f"{label}.action is invalid")
    identifier = clean_text(event.get("id"), f"{label}.id", max_bytes=24)
    require(EVENT_ID.fullmatch(identifier) is not None, f"{label}.id must look like E001")
    if action == "delete":
        return {"action": action, "id": identifier}
    reveal_status = clean_text(event.get("reveal_status"), f"{label}.reveal_status", max_bytes=24)
    require(reveal_status in REVEAL_STATUSES, f"{label}.reveal_status must be one of {REVEAL_STATUSES}")
    reveal_raw = event.get("reveal_chapter")
    reveal_chapter = None if reveal_raw is None else as_int(reveal_raw, f"{label}.reveal_chapter", minimum=1)
    if reveal_status == "未揭示":
        require(reveal_chapter is None, f"{label} must not put a future reveal chapter in established timeline facts")
    else:
        require(reveal_chapter is not None, f"{label}.reveal_chapter is required once revealed")
        require(reveal_chapter <= through_chapter, f"{label}.reveal_chapter cannot be in the future")
    return {
        "action": action,
        "id": identifier,
        "story_time": clean_text(event.get("story_time"), f"{label}.story_time", max_bytes=240),
        "objective_fact": clean_text(event.get("objective_fact"), f"{label}.objective_fact", max_bytes=480),
        "reader_knowledge": clean_text(event.get("reader_knowledge"), f"{label}.reader_knowledge", max_bytes=480),
        "reveal_status": reveal_status,
        "reveal_chapter": reveal_chapter,
        "characters": clean_string_list(event.get("characters", []), f"{label}.characters", maximum=12, item_max_bytes=120),
    }


def normalize_timeline_state(value: object, last_chapter: int) -> dict[str, dict[str, Any]]:
    events = as_mapping(value, "tracking state.timeline")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_identifier, raw_event in events.items():
        identifier = clean_text(raw_identifier, "tracking state.timeline ID", max_bytes=24)
        event = as_mapping(raw_event, f"tracking state.timeline.{identifier}")
        require_known_keys(
            event,
            {
                "id", "story_time", "objective_fact", "reader_knowledge", "reveal_status", "reveal_chapter",
                "characters", "first_recorded_chapter", "updated_chapter",
            },
            f"tracking state.timeline.{identifier}",
        )
        require(event.get("id") == identifier, f"tracking state.timeline.{identifier}.id does not match its key")
        change = normalize_timeline_change(
            {
                "action": "upsert",
                **{
                    key: value
                    for key, value in event.items()
                    if key not in {"first_recorded_chapter", "updated_chapter"}
                },
            },
            f"tracking state.timeline.{identifier}",
            allow_delete=False,
            through_chapter=last_chapter,
        )
        change.pop("action")
        first = as_int(event.get("first_recorded_chapter"), f"tracking state.timeline.{identifier}.first_recorded_chapter", minimum=1)
        updated = as_int(event.get("updated_chapter"), f"tracking state.timeline.{identifier}.updated_chapter", minimum=1)
        require(first <= last_chapter, f"timeline event {identifier} starts after current chapter")
        require(updated <= last_chapter, f"timeline event {identifier} updates after current chapter")
        change["first_recorded_chapter"] = first
        change["updated_chapter"] = updated
        normalized[identifier] = change
    return normalized


def render_timeline_views(events: dict[str, dict[str, Any]], revision: int) -> tuple[str, str]:
    author_lines = [
        "# 作者真相时间线",
        "",
        f"> 状态修订：{revision}。客观事实与读者认知的权威对照；未来揭示计划仍留在大纲。",
        "",
        "| ID | 首次登记章 | 故事时间 | 客观事实 | 读者当前认知 | 揭示状态 | 实际揭示章 |",
        "|---|---:|---|---|---|---|---:|",
    ]
    reader_lines = [
        "# 读者已知时间线",
        "",
        f"> 状态修订：{revision}。只呈现读者截至当前章节已经知道或相信的内容，不泄露作者侧客观真相。",
        "",
        "| ID | 读者当前认知 | 认知截至章 |",
        "|---|---|---:|",
    ]
    for identifier in sorted(events):
        event = events[identifier]
        reveal = f"第{event['reveal_chapter']}章" if event.get("reveal_chapter") else "—"
        characters = "、".join(event.get("characters", []))
        objective = event["objective_fact"] + (f"（涉及：{characters}）" if characters else "")
        author_lines.append(
            f"| {identifier} | 第{event['first_recorded_chapter']}章 | {event['story_time']} | {objective} | "
            f"{event['reader_knowledge']} | {event['reveal_status']} | {reveal} |"
        )
        reader_lines.append(f"| {identifier} | {event['reader_knowledge']} | 第{event['updated_chapter']}章 |")
    return "\n".join(author_lines) + "\n", "\n".join(reader_lines) + "\n"


def validate_context_input(value: object, *, include_initial_fields: bool) -> dict[str, Any]:
    context = as_mapping(value, "context")
    allowed = {"position", "long_term_constraints", "active_character_names", "continuity_risks"}
    if include_initial_fields:
        allowed.update({"recent_chapters", "next_chapter_commitments"})
    require_known_keys(context, allowed, "context")
    normalized: dict[str, Any] = {
        "position": validate_position(context.get("position")),
        "long_term_constraints": clean_string_list(
            context.get("long_term_constraints", []), "context.long_term_constraints", maximum=6
        ),
        "active_character_names": [
            safe_file_component(name, f"context.active_character_names[{index}]")
            for index, name in enumerate(as_list(context.get("active_character_names", []), "context.active_character_names"))
        ],
        "continuity_risks": clean_string_list(
            context.get("continuity_risks", []), "context.continuity_risks", maximum=5
        ),
    }
    require(len(normalized["active_character_names"]) <= 6, "context.active_character_names may contain at most 6 names")
    require(
        len({portable_name_key(name) for name in normalized["active_character_names"]})
        == len(normalized["active_character_names"]),
        "context.active_character_names contains cross-platform duplicates",
    )
    if include_initial_fields:
        recent: list[dict[str, Any]] = []
        for index, raw_item in enumerate(as_list(context.get("recent_chapters", []), "context.recent_chapters")):
            item = as_mapping(raw_item, f"context.recent_chapters[{index}]")
            require_known_keys(item, {"chapter", "summary"}, f"context.recent_chapters[{index}]")
            recent.append(
                {
                    "chapter": as_int(item.get("chapter"), f"context.recent_chapters[{index}].chapter", minimum=1),
                    "summary": clean_text(item.get("summary"), f"context.recent_chapters[{index}].summary", max_bytes=360),
                }
            )
        require(len(recent) <= 3, "context.recent_chapters may contain at most 3 items")
        normalized["recent_chapters"] = recent
        normalized["next_chapter_commitments"] = clean_string_list(
            context.get("next_chapter_commitments", []), "context.next_chapter_commitments", maximum=5
        )
    return normalized


def active_foreshadow_lines(rows: dict[str, dict[str, Any]]) -> list[str]:
    importance = {value: index for index, value in enumerate(FORESHADOW_IMPORTANCE)}
    candidates = [row for row in rows.values() if row["status"] == "已埋"]
    candidates.sort(
        key=lambda row: (importance[row["importance"]], row["planned_resolution_chapter"] or 10**12, row["id"])
    )
    result = []
    for row in candidates[:8]:
        planned = f"第{row['planned_resolution_chapter']}章" if row["planned_resolution_chapter"] else "回收章未定"
        result.append(f"{row['id']}｜{row['summary']}｜埋第{row['planted_chapter']}章｜{planned}｜{row['importance']}")
    return result


def render_context(state: dict[str, Any]) -> str:
    context = state["context"]
    position = context["position"]
    current_chapter = (
        "尚未开篇" if state["last_committed_chapter"] == 0 else f"第{state['last_committed_chapter']}章"
    )
    character_lines = [
        f"{name}｜{state['characters'][name]['identity']}｜{state['characters'][name]['state']}｜"
        f"目标：{state['characters'][name]['goal']}"
        for name in context["active_character_names"]
    ]
    sections: list[tuple[str, list[str]]] = [
        (
            "## 当前位置",
            [
                f"当前章：{current_chapter}",
                f"卷：{position['volume']}（始于第{position['volume_start_chapter']}章）",
                f"故事时间：{position['story_time']}",
                f"场景：{position['scene']}",
            ],
        ),
        ("## 长期约束", context["long_term_constraints"]),
        ("## 核心角色状态", character_lines),
        ("## 活跃伏笔", active_foreshadow_lines(state["foreshadow"])),
        ("## 近三章速记", [f"第{item['chapter']}章｜{item['summary']}" for item in context["recent_chapters"]]),
        ("## 下一章承诺", context["next_chapter_commitments"]),
        ("## 连贯性风险", context["continuity_risks"]),
    ]
    lines = [
        f"# 写作连续性上下文 — {state['book_title']}",
        "",
        f"> 状态修订：{state['state_revision']}。截至当前章的续写状态卡，只放下一章真正需要的连续性状态。",
        "",
    ]
    for heading, values in sections:
        lines.append(heading)
        lines.extend(f"- {value}" for value in values or ["无"])
        lines.append("")
    payload = "\n".join(lines).rstrip() + "\n"
    headings = tuple(line for line in payload.splitlines() if line.startswith("## "))
    require(headings == CONTEXT_HEADINGS, "generated context headings do not match the seven-section schema")
    require(byte_size(payload) <= CONTEXT_MAX_BYTES, f"hot context exceeds {CONTEXT_MAX_BYTES} bytes")
    return payload


def normalize_delta(
    value: object,
    *,
    through_chapter: int,
    snapshots: dict[str, dict[str, Any]],
    existing_core_names: dict[str, str],
) -> dict[str, Any]:
    delta = as_mapping(value, "delta")
    require_known_keys(
        delta,
        {
            "result", "character_changes", "foreshadow_changes", "timeline_events", "verdict_changes",
            "evidence_changes", "geo_changes", "scene_changes",
            "constraints", "next_chapter_commitments", "retired_context_items", "retired_characters",
        },
        "delta",
    )
    retired_characters = [
        safe_file_component(name, f"delta.retired_characters[{index}]")
        for index, name in enumerate(as_list(delta.get("retired_characters", []), "delta.retired_characters"))
    ]
    retired_keys = [portable_name_key(name) for name in retired_characters]
    require(len(retired_keys) == len(set(retired_keys)), "delta.retired_characters contains duplicate characters")
    retiring = set(retired_keys)
    character_changes: list[dict[str, Any]] = []
    for index, raw_change in enumerate(as_list(delta.get("character_changes", []), "delta.character_changes")):
        change = as_mapping(raw_change, f"delta.character_changes[{index}]")
        require_known_keys(change, {"name", "change"}, f"delta.character_changes[{index}]")
        name = safe_file_component(change.get("name"), f"delta.character_changes[{index}].name")
        existing = existing_core_names.get(portable_name_key(name))
        is_core = name in snapshots or existing is not None
        # 本章退役的角色记录最后一次变化即可，不必再交一份马上要删的快照。
        require(
            not is_core or name in snapshots or portable_name_key(name) in retiring,
            f"core character {name} changed but has no current snapshot",
        )
        character_changes.append(
            {"name": name, "change": clean_text(change.get("change"), f"delta.character_changes[{index}].change", max_bytes=360)}
        )
    character_keys = [portable_name_key(item["name"]) for item in character_changes]
    require(len(character_keys) == len(set(character_keys)), "delta.character_changes contains duplicate characters")
    foreshadow_changes = [
        normalize_foreshadow_change(
            raw, f"delta.foreshadow_changes[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("foreshadow_changes", []), "delta.foreshadow_changes"))
    ]
    timeline_events = [
        normalize_timeline_change(
            raw, f"delta.timeline_events[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("timeline_events", []), "delta.timeline_events"))
    ]
    verdict_changes = [
        normalize_verdict_change(
            raw, f"delta.verdict_changes[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("verdict_changes", []), "delta.verdict_changes"))
    ]
    evidence_changes = [
        normalize_evidence_change(
            raw, f"delta.evidence_changes[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("evidence_changes", []), "delta.evidence_changes"))
    ]
    geo_changes = [
        normalize_geo_change(
            raw, f"delta.geo_changes[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("geo_changes", []), "delta.geo_changes"))
    ]
    scene_changes = [
        normalize_scene_change(
            raw, f"delta.scene_changes[{index}]", allow_delete=True, through_chapter=through_chapter
        )
        for index, raw in enumerate(as_list(delta.get("scene_changes", []), "delta.scene_changes"))
    ]
    require(
        len({item["id"] for item in foreshadow_changes}) == len(foreshadow_changes),
        "delta.foreshadow_changes contains duplicate IDs",
    )
    require(
        len({item["id"] for item in timeline_events}) == len(timeline_events),
        "delta.timeline_events contains duplicate IDs",
    )
    require(
        len({item["id"] for item in verdict_changes}) == len(verdict_changes),
        "delta.verdict_changes contains duplicate IDs",
    )
    require(
        len({item["id"] for item in evidence_changes}) == len(evidence_changes),
        "delta.evidence_changes contains duplicate IDs",
    )
    require(
        len({item["id"] for item in geo_changes}) == len(geo_changes),
        "delta.geo_changes contains duplicate IDs",
    )
    require(
        len({item["id"] for item in scene_changes}) == len(scene_changes),
        "delta.scene_changes contains duplicate IDs",
    )
    require(
        set(snapshots).issubset({item["name"] for item in character_changes}),
        "character_snapshots must contain exactly the core characters changed by this transaction",
    )
    return {
        "result": clean_text(delta.get("result"), "delta.result", max_bytes=480),
        "character_changes": character_changes,
        "foreshadow_changes": foreshadow_changes,
        "timeline_events": timeline_events,
        "verdict_changes": verdict_changes,
        "evidence_changes": evidence_changes,
        "geo_changes": geo_changes,
        "scene_changes": scene_changes,
        "constraints": clean_string_list(delta.get("constraints", []), "delta.constraints", maximum=6),
        "next_chapter_commitments": clean_string_list(
            delta.get("next_chapter_commitments", []), "delta.next_chapter_commitments", maximum=5
        ),
        "retired_context_items": clean_string_list(
            delta.get("retired_context_items", []), "delta.retired_context_items", maximum=11
        ),
        "retired_characters": retired_characters,
    }


def render_delta(chapter: int, title: str, delta: dict[str, Any], core_names: set[str]) -> str:
    lines = [
        f"# 第{chapter:03d}章 · {title}",
        f"- 结果：{delta['result']}",
        "- 下一章承诺：" + ("；".join(delta["next_chapter_commitments"]) or "无"),
        "",
        "## 角色变化",
    ]
    lines.extend(
        f"- {item['name']}｜{'核心' if item['name'] in core_names else '临时'}｜{item['change']}"
        for item in delta["character_changes"]
    )
    if not delta["character_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 伏笔变化"])
    for item in delta["foreshadow_changes"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            planned = f"第{item['planned_resolution_chapter']}章" if item["planned_resolution_chapter"] else "未定"
            lines.append(f"- {item['id']}｜{item['status']}｜{item['summary']}｜回收{planned}")
    if not delta["foreshadow_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 时间与揭示"])
    for item in delta["timeline_events"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            lines.append(
                f"- {item['id']}｜{item['story_time']}｜事实：{item['objective_fact']}｜"
                f"读者：{item['reader_knowledge']}｜{item['reveal_status']}"
            )
    if not delta["timeline_events"]:
        lines.append("- 无")
    lines.extend(["", "## 事件定性"])
    for item in delta["verdict_changes"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            lines.append(f"- {item['id']}｜{item['status']}｜{item['event']}｜{item['verdict']}")
    if not delta["verdict_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 物证变化"])
    for item in delta["evidence_changes"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            lines.append(f"- {item['id']}｜{item['status']}｜{item['name']}｜{item['holder'] or '—'}")
    if not delta["evidence_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 地理变化"])
    for item in delta["geo_changes"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            bearing = f"{item['name']}在{item['ref']}以{item['direction']}" if item["ref"] else "仅登记"
            lines.append(f"- {item['id']}｜{item['name']}｜{bearing}")
    if not delta["geo_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 场景变化"])
    for item in delta["scene_changes"]:
        if item["action"] == "delete":
            lines.append(f"- {item['id']}｜删除当前登记")
        else:
            lines.append(f"- {item['id']}｜{item['name']}｜{item['status']}｜{item['current'] or item['anchor']}")
    if not delta["scene_changes"]:
        lines.append("- 无")
    lines.extend(["", "## 连贯性约束"])
    lines.extend(f"- {item}" for item in delta["constraints"])
    if not delta["constraints"]:
        lines.append("- 无")
    retired = delta.get("retired_context_items", []) + [
        f"角色状态：{name}" for name in delta.get("retired_characters", [])
    ]
    if retired:
        # 退役条目在此留档，续写状态卡收缩后仍可回查当初撤下了什么。
        lines.extend(["", "## 本章退役登记"])
        lines.extend(f"- {item}" for item in retired)
    payload = "\n".join(lines) + "\n"
    size = byte_size(payload)
    require(size <= DELTA_MAX_BYTES, f"chapter delta is {size} bytes; hard cap is {DELTA_MAX_BYTES}")
    return payload


def normalize_state(document: object) -> dict[str, Any]:
    root = as_mapping(document, "tracking state")
    require_known_keys(
        root,
        {
            "schema_version", "book_title", "last_committed_chapter", "imported_through_chapter",
            "state_revision", "context", "characters", "foreshadow", "timeline", "verdicts",
            "evidence", "geo", "scenes", "chapter_summaries",
        },
        "tracking state",
    )
    require(
        root.get("schema_version") in SUPPORTED_STATE_VERSIONS,
        f"tracking state schema is unsupported (expected one of {SUPPORTED_STATE_VERSIONS})",
    )
    last_chapter = as_int(root.get("last_committed_chapter"), "tracking state.last_committed_chapter")
    imported_through = as_int(root.get("imported_through_chapter"), "tracking state.imported_through_chapter")
    require(imported_through <= last_chapter, "imported chapter cutoff exceeds current chapter")
    context = validate_context_input(root.get("context"), include_initial_fields=True)
    require(
        context["position"]["volume_start_chapter"] <= max(1, last_chapter),
        "context.position.volume_start_chapter is after the current writing position",
    )
    recent_numbers = [item["chapter"] for item in context["recent_chapters"]]
    require(recent_numbers == sorted(recent_numbers), "context.recent_chapters must be ordered")
    require(len(recent_numbers) == len(set(recent_numbers)), "context.recent_chapters contains duplicates")
    require(all(chapter <= last_chapter for chapter in recent_numbers), "context.recent_chapters cannot include future chapters")
    characters = normalize_snapshots(root.get("characters", {}), "tracking state.characters")
    for name in context["active_character_names"]:
        require(name in characters, f"active core character {name} has no current snapshot")
    foreshadow = normalize_foreshadow_state(root.get("foreshadow", {}), last_chapter)
    timeline = normalize_timeline_state(root.get("timeline", {}), last_chapter)
    # v4/v5/v6 存量读入时无 verdicts/evidence/geo/scenes 键 → 空 dict；写盘统一归一化为 v7（见模块头注释）。
    verdicts = normalize_verdict_state(root.get("verdicts", {}), last_chapter)
    evidence = normalize_evidence_state(root.get("evidence", {}), last_chapter)
    geo = normalize_geo_state(root.get("geo", {}), last_chapter)
    scenes = normalize_scene_state(root.get("scenes", {}), last_chapter)
    chapter_summaries = normalize_chapter_summaries(root.get("chapter_summaries", {}), last_chapter)
    if last_chapter == 0:
        require(not foreshadow, "a chapter-0 project cannot have planted foreshadow facts")
        require(not timeline, "a chapter-0 project cannot have established timeline facts")
        require(not verdicts, "a chapter-0 project cannot have established verdict assets")
        require(not evidence, "a chapter-0 project cannot have registered evidence")
        require(not geo, "a chapter-0 project cannot have registered geography")
        require(not scenes, "a chapter-0 project cannot have registered scenes")
    return {
        "schema_version": TRACKING_SCHEMA_VERSION,
        "book_title": clean_text(root.get("book_title"), "tracking state.book_title", max_bytes=240),
        "last_committed_chapter": last_chapter,
        "imported_through_chapter": imported_through,
        "state_revision": as_int(root.get("state_revision"), "tracking state.state_revision"),
        "context": context,
        "characters": characters,
        "foreshadow": foreshadow,
        "timeline": timeline,
        "verdicts": verdicts,
        "evidence": evidence,
        "geo": geo,
        "scenes": scenes,
        "chapter_summaries": chapter_summaries,
    }


def load_state(project: Path) -> dict[str, Any]:
    path = state_path(project)
    require(path.exists(), "tracking state is missing; run init first")
    return normalize_state(read_json(path))


def normalize_initial_document(document: object) -> dict[str, Any]:
    root = as_mapping(document, "init input")
    require_known_keys(
        root,
        {"schema_version", "book_title", "last_chapter", "context", "character_snapshots", "foreshadow", "timeline_events", "verdicts", "evidence", "geo", "scenes", "chapter_summaries"},
        "init input",
    )
    require(root.get("schema_version") == INPUT_SCHEMA_VERSION, "init input schema_version is unsupported")
    last_chapter = as_int(root.get("last_chapter"), "last_chapter")
    context = validate_context_input(root.get("context"), include_initial_fields=True)
    snapshots = normalize_snapshots(root.get("character_snapshots", {}))
    foreshadow: dict[str, dict[str, Any]] = {}
    for index, raw_row in enumerate(as_list(root.get("foreshadow", []), "foreshadow")):
        row = normalize_foreshadow_change(
            raw_row, f"foreshadow[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(row["id"] not in foreshadow, f"duplicate foreshadow ID {row['id']}")
        row.pop("action")
        row["updated_chapter"] = max(1, last_chapter)
        foreshadow[row["id"]] = row
    timeline: dict[str, dict[str, Any]] = {}
    for index, raw_event in enumerate(as_list(root.get("timeline_events", []), "timeline_events")):
        event = normalize_timeline_change(
            raw_event, f"timeline_events[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(event["id"] not in timeline, f"duplicate timeline event ID {event['id']}")
        event.pop("action")
        event["first_recorded_chapter"] = max(1, last_chapter)
        event["updated_chapter"] = max(1, last_chapter)
        timeline[event["id"]] = event
    verdicts: dict[str, dict[str, Any]] = {}
    for index, raw_verdict in enumerate(as_list(root.get("verdicts", []), "verdicts")):
        verdict = normalize_verdict_change(
            raw_verdict, f"verdicts[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(verdict["id"] not in verdicts, f"duplicate verdict ID {verdict['id']}")
        verdict.pop("action")
        verdict["updated_chapter"] = max(1, last_chapter)
        verdicts[verdict["id"]] = verdict
    evidence: dict[str, dict[str, Any]] = {}
    for index, raw_item in enumerate(as_list(root.get("evidence", []), "evidence")):
        item = normalize_evidence_change(
            raw_item, f"evidence[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(item["id"] not in evidence, f"duplicate evidence ID {item['id']}")
        item.pop("action")
        item["updated_chapter"] = max(1, last_chapter)
        evidence[item["id"]] = item
    geo: dict[str, dict[str, Any]] = {}
    for index, raw_item in enumerate(as_list(root.get("geo", []), "geo")):
        item = normalize_geo_change(
            raw_item, f"geo[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(item["id"] not in geo, f"duplicate geo ID {item['id']}")
        item.pop("action")
        item["updated_chapter"] = max(1, last_chapter)
        geo[item["id"]] = item
    scenes: dict[str, dict[str, Any]] = {}
    for index, raw_item in enumerate(as_list(root.get("scenes", []), "scenes")):
        item = normalize_scene_change(
            raw_item, f"scenes[{index}]", allow_delete=False, through_chapter=last_chapter
        )
        require(item["id"] not in scenes, f"duplicate scene ID {item['id']}")
        item.pop("action")
        item["updated_chapter"] = max(1, last_chapter)
        scenes[item["id"]] = item
    return normalize_state(
        {
            "schema_version": TRACKING_SCHEMA_VERSION,
            "book_title": clean_text(root.get("book_title"), "book_title", max_bytes=240),
            "last_committed_chapter": last_chapter,
            "imported_through_chapter": last_chapter,
            "state_revision": 0,
            "context": context,
            "characters": snapshots,
            "foreshadow": foreshadow,
            "timeline": timeline,
            "verdicts": verdicts,
            "evidence": evidence,
            "geo": geo,
            "scenes": scenes,
            "chapter_summaries": normalize_chapter_summaries(root.get("chapter_summaries", {}), last_chapter),
        }
    )


def normalize_transaction(state: dict[str, Any], document: object) -> dict[str, Any]:
    root = as_mapping(document, "transaction")
    require_known_keys(
        root,
        {
            "schema_version", "mode", "chapter", "chapter_title", "expected_state_revision",
            "delta", "context", "character_snapshots",
        },
        "transaction",
    )
    require(root.get("schema_version") == INPUT_SCHEMA_VERSION, "transaction schema_version is unsupported")
    mode = clean_text(root.get("mode"), "mode", max_bytes=24)
    require(mode in {"append", "revision"}, "mode must be append or revision")
    chapter = as_int(root.get("chapter"), "chapter", minimum=1)
    expected_revision = as_int(root.get("expected_state_revision"), "expected_state_revision")
    require(expected_revision == state["state_revision"], "tracking state changed since this transaction was prepared")
    last = state["last_committed_chapter"]
    if mode == "append":
        require(chapter == last + 1, f"append chapter must be {last + 1}, got {chapter}")
    else:
        require(chapter <= last, f"cannot revise unwritten chapter {chapter}; last committed chapter is {last}")
    context = validate_context_input(root.get("context"), include_initial_fields=False)
    snapshots = normalize_snapshots(root.get("character_snapshots", {}))
    existing_names = {portable_name_key(name): name for name in state["characters"]}
    for name in snapshots:
        existing = existing_names.get(portable_name_key(name))
        require(existing is None or existing == name, f"character {name} conflicts with existing character {existing}")
    through_chapter = chapter if mode == "append" else last
    delta = normalize_delta(
        root.get("delta"),
        through_chapter=through_chapter,
        snapshots=snapshots,
        existing_core_names=existing_names,
    )
    return {
        "mode": mode,
        "chapter": chapter,
        "title": clean_text(root.get("chapter_title"), "chapter_title", max_bytes=240),
        "delta": delta,
        "context": context,
        "snapshots": snapshots,
    }


def checkpoint_record(
    change: dict[str, Any], chapter: int, previous: dict[str, Any] | None, *, keep_first_chapter: bool = False
) -> dict[str, Any]:
    current = {key: value for key, value in change.items() if key != "action"}
    current["updated_chapter"] = max(previous["updated_chapter"] if previous else chapter, chapter)
    if keep_first_chapter:
        current["first_recorded_chapter"] = previous["first_recorded_chapter"] if previous else chapter
    return current


def merge_transaction(state: dict[str, Any], transaction: dict[str, Any]) -> dict[str, Any]:
    next_state = copy.deepcopy(state)
    chapter = transaction["chapter"]
    if transaction["mode"] == "append":
        next_state["last_committed_chapter"] = chapter
    next_state["state_revision"] += 1
    next_state["characters"].update(transaction["snapshots"])

    next_context = transaction["context"]
    # 退役说的是「从此刻起离开当前状态」，只有 append 的逐章记录代表此刻；
    # 修订记录属于被改写的旧章，落在那里会谎报退役发生的章节。
    is_revision = transaction["mode"] == "revision"
    require(
        not (is_revision and transaction["delta"]["retired_characters"]),
        "retired_characters must be committed in an append transaction, not a revision",
    )
    for name in transaction["delta"]["retired_characters"]:
        require(name in next_state["characters"], f"retired character {name} has no current snapshot")
        require(
            name not in transaction["snapshots"],
            f"character {name} cannot be retired and updated in the same transaction",
        )
        require(
            name not in next_context["active_character_names"],
            f"retired character {name} is still listed in context.active_character_names",
        )
        next_state["characters"].pop(name)

    # 上下文条目是整份提交的；漏写会静默丢历史裁定，因此掉落必须显式声明。
    previous_items = set(state["context"]["long_term_constraints"]) | set(state["context"]["continuity_risks"])
    dropped = previous_items - (set(next_context["long_term_constraints"]) | set(next_context["continuity_risks"]))
    require(
        not (is_revision and dropped),
        "a revision must resubmit every current context item; retire them in an append transaction instead: "
        + "；".join(sorted(dropped)),
    )
    undeclared = sorted(dropped - set(transaction["delta"]["retired_context_items"]))
    require(
        not undeclared,
        "context items were dropped without being declared in delta.retired_context_items: "
        + "；".join(undeclared),
    )
    transaction["delta"]["retired_context_items"] = sorted(dropped)

    for change in transaction["delta"]["foreshadow_changes"]:
        if change["action"] == "delete":
            next_state["foreshadow"].pop(change["id"], None)
        else:
            next_state["foreshadow"][change["id"]] = checkpoint_record(
                change, chapter, next_state["foreshadow"].get(change["id"])
            )
    for change in transaction["delta"]["timeline_events"]:
        if change["action"] == "delete":
            next_state["timeline"].pop(change["id"], None)
        else:
            next_state["timeline"][change["id"]] = checkpoint_record(
                change, chapter, next_state["timeline"].get(change["id"]), keep_first_chapter=True
            )
    for change in transaction["delta"]["verdict_changes"]:
        if change["action"] == "delete":
            next_state["verdicts"].pop(change["id"], None)
        else:
            next_state["verdicts"][change["id"]] = checkpoint_record(
                change, chapter, next_state["verdicts"].get(change["id"])
            )
    for change in transaction["delta"]["evidence_changes"]:
        if change["action"] == "delete":
            next_state["evidence"].pop(change["id"], None)
        else:
            next_state["evidence"][change["id"]] = checkpoint_record(
                change, chapter, next_state["evidence"].get(change["id"])
            )
    for change in transaction["delta"]["geo_changes"]:
        if change["action"] == "delete":
            next_state["geo"].pop(change["id"], None)
        else:
            next_state["geo"][change["id"]] = checkpoint_record(
                change, chapter, next_state["geo"].get(change["id"])
            )
    for change in transaction["delta"]["scene_changes"]:
        if change["action"] == "delete":
            next_state["scenes"].pop(change["id"], None)
        else:
            next_state["scenes"][change["id"]] = checkpoint_record(
                change, chapter, next_state["scenes"].get(change["id"])
            )

    recent_by_chapter = {item["chapter"]: item for item in state["context"]["recent_chapters"]}
    if chapter in recent_by_chapter or transaction["mode"] == "append":
        recent_by_chapter[chapter] = {"chapter": chapter, "summary": transaction["delta"]["result"]}
    recent = sorted(recent_by_chapter.values(), key=lambda item: item["chapter"])[-3:]
    # P2 金字塔：章摘要持久层（近三章速记是滚动窗口，chapter_summaries 存全量）
    next_state.setdefault("chapter_summaries", {})[str(chapter)] = transaction["delta"]["result"]
    current_last = next_state["last_committed_chapter"]
    next_commitments = (
        transaction["delta"]["next_chapter_commitments"]
        if transaction["mode"] == "append" or chapter == current_last
        else state["context"]["next_chapter_commitments"]
    )
    next_state["context"] = {
        **next_context,
        "recent_chapters": recent,
        "next_chapter_commitments": next_commitments,
    }
    return normalize_state(next_state)


# P2 章节金字塔派生视图：全量章摘要表 + 10章聚合标记。
# 消费方：review 架构视角（审第N章 = 卷摘要 + 近10章章摘要 + 本章全文 ≈ 5K 字）、
# 写章读盘、P3 收线审计。聚合层与卷摘要由编排层按需生成，不在此渲染。
def render_pyramid(state: dict[str, Any]) -> str:
    summaries = state.get("chapter_summaries", {})
    last_chapter = state["last_committed_chapter"]
    revision = state["state_revision"]
    lines = [
        f"# 章节金字塔 — {state['book_title']}",
        "",
        f"> 状态修订：{revision}。按需取层：审第N章 = 卷摘要 + 近10章章摘要 + 本章全文。",
        "",
        "## 章摘要（全量）",
        "",
        "| 章 | 摘要 |",
        "|---|---|",
    ]
    if last_chapter == 0:
        lines.append("| — | 尚未开篇 |")
    for chapter in range(1, last_chapter + 1):
        summary = summaries.get(str(chapter), "—")
        lines.append(f"| {chapter} | {summary} |")
    # 10章聚合标记（编排层按需生成，二叉树两两合并）
    if last_chapter >= 10:
        lines.extend(["", "## 10章聚合", "", "| 范围 | 状态 |", "|---|---|"])
        for start in range(1, last_chapter + 1, 10):
            end = min(start + 9, last_chapter)
            lines.append(f"| {start}-{end} | 待生成 |")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_views(state: dict[str, Any]) -> dict[str, str]:
    revision = state["state_revision"]
    views = {
        "上下文.md": render_context(state),
        "伏笔.md": render_foreshadow(state["foreshadow"], revision),
        "事件定性资产.md": render_verdict(state["verdicts"], revision),
        "物证台账.md": render_evidence(state["evidence"], revision),
        "地理台账.md": render_geo(state["geo"], revision),
        "场景台账.md": render_scene(state["scenes"], revision),
        "章节金字塔.md": render_pyramid(state),
    }
    author, reader = render_timeline_views(state["timeline"], revision)
    views["时间线/作者真相.md"] = author
    views["时间线/读者已知.md"] = reader
    for name, snapshot in state["characters"].items():
        views[f"角色状态/{name}.md"] = render_snapshot(
            name, snapshot, state["last_committed_chapter"], revision
        )
    return views


def write_views(tracking: Path, views: dict[str, str]) -> None:
    # 上下文携带 next revision，先写它；任何后续失败都会让 hook/check 发现
    # 上下文 revision 与最后提交的 _tracking-state.json 不一致。
    write_if_changed(tracking / "上下文.md", views["上下文.md"])
    for relative in sorted(path for path in views if path != "上下文.md"):
        write_if_changed(tracking / relative, views[relative])
    expected_character_files = {
        Path(relative).name for relative in views if relative.startswith("角色状态/")
    }
    character_dir = tracking / "角色状态"
    character_dir.mkdir(parents=True, exist_ok=True)
    for path in character_dir.glob("*.md"):
        if path.name not in expected_character_files:
            path.unlink()


def warn_sizes(views: dict[str, str], delta_payload: str | None = None) -> None:
    if delta_payload is not None and byte_size(delta_payload) > DELTA_TARGET_BYTES:
        emit(
            f"WARNING: chapter delta is {byte_size(delta_payload)} bytes; target is <= {DELTA_TARGET_BYTES}",
            error=True,
        )
    context_size = byte_size(views["上下文.md"])
    if context_size > CONTEXT_TARGET_BYTES:
        emit(f"WARNING: hot context is {context_size} bytes; target is <= {CONTEXT_TARGET_BYTES}", error=True)
    for relative, payload in views.items():
        if not relative.startswith("角色状态/"):
            continue
        size = byte_size(payload)
        if size > SNAPSHOT_TARGET_BYTES:
            emit(
                f"WARNING: character snapshot {Path(relative).stem} is {size} bytes; target is <= {SNAPSHOT_TARGET_BYTES}",
                error=True,
            )


def initialize(project: Path, document: object) -> dict[str, Any]:
    tracking = tracking_root(project)
    require(not state_path(project).exists(), "tracking state already exists; init never overwrites project state")
    state = normalize_initial_document(document)
    views = render_views(state)
    state_payload = json_payload(state)

    # 输入全部校验通过后才动用户文件，失败的 init 不会挪走任何东西。
    archived = archive_retired_tracking_paths(tracking)
    for directory in (tracking / "逐章记录", tracking / "角色状态", tracking / "时间线"):
        directory.mkdir(parents=True, exist_ok=True)
    write_views(tracking, views)
    atomic_write_text(state_path(project), state_payload)
    warn_sizes(views)
    if archived:
        emit(
            f"NOTE: 旧追踪结构已原样移入 追踪/{RETIRED_ARCHIVE_DIR}/：{', '.join(archived)}；"
            "当前状态以本次 init 输入为准，旧文件不参与解析。",
            error=True,
        )
    return state


def apply_transaction(project: Path, document: object) -> dict[str, Any]:
    tracking = tracking_root(project)
    require_no_retired_tracking_paths(tracking)
    state = load_state(project)
    transaction = normalize_transaction(state, document)
    next_state = merge_transaction(state, transaction)

    delta_payload = render_delta(
        transaction["chapter"],
        transaction["title"],
        transaction["delta"],
        # 本章退役的角色在 next_state 里已被删除，但本章记录里仍应标为核心。
        set(next_state["characters"]) | set(transaction["delta"]["retired_characters"]),
    )
    views = render_views(next_state)
    next_state_payload = json_payload(next_state)
    path = delta_path(tracking, transaction["chapter"])
    if transaction["mode"] == "append" and path.exists():
        require(
            path.read_text(encoding="utf-8") == delta_payload,
            f"chapter delta {transaction['chapter']} already exists with different content",
        )

    write_if_changed(path, delta_payload)
    write_views(tracking, views)
    # 唯一权威文件最后落盘；在此之前失败可用同一事务直接重跑。
    atomic_write_text(state_path(project), next_state_payload)
    warn_sizes(views, delta_payload)

    # P2 执行偏差回填提醒（docs/07 §二 P2）＋ R1 未落实行章号校验（docs/08）：提交章 N 时
    # 同章细纲缺「执行偏差」区 → stderr 提醒；区存在且「未落实」值非「无」但不含顺延章号 →
    # stderr 提醒（无去向的未落实＝承诺无声消失）。均不阻断。stdout 是提交产物的单行
    # JSON 通道，提醒只走 stderr（v1.1）。细纲读不了不提醒（fail-open：本检查是纪律出声口，
    # 不是硬门）。
    outline_dir = project.resolve() / "大纲"
    try:
        outline_path = next(
            (
                entry
                for entry in outline_dir.iterdir()
                if re.fullmatch(rf"细纲_第0*{transaction['chapter']}章.*\.md", entry.name)
            ),
            None,
        )
        if outline_path is not None and "执行偏差" not in outline_path.read_text(encoding="utf-8"):
            emit(
                f"提醒：{outline_path.name} 缺「执行偏差（检测驱动回填）」区——写章循环第 7 步章检后"
                "按 outline-deliver 检测结果回填变体/未落实项（细纲协议 R1；未落实项顺延须同步登记 "
                "追踪/伏笔.md 或卷纲待办）。本提醒不阻断提交。",
                error=True,
            )
        elif outline_path is not None:
            outline_text = outline_path.read_text(encoding="utf-8")
            pending = re.search(r"未落实[:：]\s*([^\n]+)", outline_text)
            if pending is not None:
                pending_value = pending.group(1).strip()
                if pending_value and not pending_value.startswith("无") and not re.search(r"第?\d+章|[一二三四五六七八九十百]+章", pending_value):
                    emit(
                        f"提醒：{outline_path.name} 「未落实」值「{pending_value[:30]}」不含顺延章号——"
                        "无去向的未落实＝承诺无声消失（R1：每条偏差终态必居其一：修复/修订/顺延登记/升级）。",
                        error=True,
                    )
    except (OSError, UnicodeError):
        pass
    return next_state


def backfill_entities(project: Path, document: object) -> dict[str, Any]:
    """存量迁移：把既往高潮章事件定性 / 物证 / 地理断言补录进现有 state。

    G2 verdicts（05 §2）、T1/T2 evidence/geo（05 §5）与 P4 scenes 同一入口：编排层列候选
    清单、作者确认原句后产出 JSON；v4/v5/v6 存量 state 在此自动升级 v7（读入兼容、写盘
    归一）。四个列表键均可选，旧版只有 verdicts 的输入照常工作。不新增逐章记录——补录
    的是历史事实，不谎报「变更发生在某一章」。
    """
    root = as_mapping(document, "backfill input")
    require_known_keys(root, {"schema_version", "verdicts", "evidence", "geo", "scenes"}, "backfill input")
    require(root.get("schema_version") == INPUT_SCHEMA_VERSION, "backfill input schema_version is unsupported")
    tracking = tracking_root(project)
    require_no_retired_tracking_paths(tracking)
    state = load_state(project)
    last_chapter = state["last_committed_chapter"]
    verdict_changes = [
        normalize_verdict_change(
            raw, f"backfill verdicts[{index}]", allow_delete=True, through_chapter=last_chapter
        )
        for index, raw in enumerate(as_list(root.get("verdicts", []), "backfill verdicts"))
    ]
    evidence_changes = [
        normalize_evidence_change(
            raw, f"backfill evidence[{index}]", allow_delete=True, through_chapter=last_chapter
        )
        for index, raw in enumerate(as_list(root.get("evidence", []), "backfill evidence"))
    ]
    geo_changes = [
        normalize_geo_change(
            raw, f"backfill geo[{index}]", allow_delete=True, through_chapter=last_chapter
        )
        for index, raw in enumerate(as_list(root.get("geo", []), "backfill geo"))
    ]
    scene_changes = [
        normalize_scene_change(
            raw, f"backfill scenes[{index}]", allow_delete=True, through_chapter=last_chapter
        )
        for index, raw in enumerate(as_list(root.get("scenes", []), "backfill scenes"))
    ]
    require(
        len({item["id"] for item in verdict_changes}) == len(verdict_changes),
        "backfill verdicts contains duplicate IDs",
    )
    require(
        len({item["id"] for item in evidence_changes}) == len(evidence_changes),
        "backfill evidence contains duplicate IDs",
    )
    require(
        len({item["id"] for item in geo_changes}) == len(geo_changes),
        "backfill geo contains duplicate IDs",
    )
    require(
        len({item["id"] for item in scene_changes}) == len(scene_changes),
        "backfill scenes contains duplicate IDs",
    )
    for change in verdict_changes:
        if change["action"] == "delete":
            state["verdicts"].pop(change["id"], None)
        else:
            state["verdicts"][change["id"]] = checkpoint_record(
                change, last_chapter, state["verdicts"].get(change["id"])
            )
    for change in evidence_changes:
        if change["action"] == "delete":
            state["evidence"].pop(change["id"], None)
        else:
            state["evidence"][change["id"]] = checkpoint_record(
                change, last_chapter, state["evidence"].get(change["id"])
            )
    for change in geo_changes:
        if change["action"] == "delete":
            state["geo"].pop(change["id"], None)
        else:
            state["geo"][change["id"]] = checkpoint_record(
                change, last_chapter, state["geo"].get(change["id"])
            )
    for change in scene_changes:
        if change["action"] == "delete":
            state["scenes"].pop(change["id"], None)
        else:
            state["scenes"][change["id"]] = checkpoint_record(
                change, last_chapter, state["scenes"].get(change["id"])
            )
    state["state_revision"] += 1
    state = normalize_state(state)
    views = render_views(state)
    # 与 commit 相同的落盘顺序：派生视图先行，权威 state 最后。
    write_views(tracking, views)
    atomic_write_text(state_path(project), json_payload(state))
    return state


def check_project(project: Path) -> dict[str, Any]:
    tracking = tracking_root(project)
    require_no_retired_tracking_paths(tracking)
    state = load_state(project)
    last_chapter = state["last_committed_chapter"]
    required_delta_start = state["imported_through_chapter"] + 1
    for chapter in range(required_delta_start, last_chapter + 1):
        require(delta_path(tracking, chapter).exists(), f"chapter delta {chapter} is missing")
    for path in (tracking / "逐章记录").glob("第*章.md"):
        match = re.fullmatch(r"第(\d+)章\.md", path.name)
        require(match is not None, f"chapter delta has an invalid filename: {path.name}")
        chapter = as_int(int(match.group(1)), f"chapter delta {path.name}", minimum=1)
        require(path == delta_path(tracking, chapter), f"chapter delta {chapter} filename is not canonical")
        require(chapter <= last_chapter, f"chapter delta {chapter} exceeds last_committed_chapter")
        require(path.stat().st_size <= DELTA_MAX_BYTES, f"chapter delta {chapter} exceeds {DELTA_MAX_BYTES} bytes")

    expected_views = render_views(state)
    for relative, expected in expected_views.items():
        path = tracking / relative
        require(path.exists(), f"derived view is missing: {relative}")
        require(
            path.read_text(encoding="utf-8") == expected,
            f"derived view differs from _tracking-state.json: {relative}",
        )
    expected_character_files = {
        Path(relative).name for relative in expected_views if relative.startswith("角色状态/")
    }
    actual_character_files = {path.name for path in (tracking / "角色状态").glob("*.md")}
    require(actual_character_files == expected_character_files, "character snapshot files differ from tracking state")

    # S1 时滞扫描（docs/07 §二 S1）：正文已落盘的最大章号 > 追踪提交章号 → 报欠账退 2。
    # 既定流程中 check 只在批收尾/预检时点跑（写章循环第 6 步提交先于任何 check），
    # 无中间态误报窗口；fail-open：正文目录缺失或命名不匹配静默跳过。hook guard 已在
    # hook 宿主拦「last_committed < num−1」（新建章文件时），此处补无 hook 宿主与编排层
    # 预检面——同一判据多层布防，不冲突（61-63 事故的直接防线：写 61-63 时状态停 8/26）。
    prose_dir = project.resolve() / "正文"
    try:
        prose_names = [entry.name for entry in prose_dir.iterdir()]
    except OSError:
        prose_names = []
    prose_nums = []
    for name in prose_names:
        match = re.match(r"第0*(\d+)章", name)
        if match and name.endswith(".md"):
            prose_nums.append(int(match.group(1)))
    if prose_nums and max(prose_nums) > last_chapter:
        raise TrackingError(
            f"第 {last_chapter + 1}…{max(prose_nums)} 章已落盘未提交（追踪记至第 {last_chapter} 章）"
            ": 先跑 commit 补提交再过检（docs/07 S1 时滞预检；批收尾三查之一：时滞=0）"
        )
    return state


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("init", "commit", "backfill"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--project", type=Path, required=True, help="book project root containing 追踪/")
        subparser.add_argument("--input", type=Path, required=True, help="UTF-8 JSON input document")
    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("--project", type=Path, required=True, help="book project root containing 追踪/")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "init":
            result = initialize(args.project, read_json(args.input))
        elif args.command == "commit":
            result = apply_transaction(args.project, read_json(args.input))
        elif args.command == "backfill":
            result = backfill_entities(args.project, read_json(args.input))
        else:
            result = check_project(args.project)
    except (TrackingError, OSError, UnicodeError) as exc:
        emit(f"ERROR: {exc}", error=True)
        return 2
    emit(
        json.dumps(
            {
                "last_committed_chapter": result["last_committed_chapter"],
                "state_revision": result["state_revision"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
