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
import errno
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
from datetime import datetime
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
# D1 长度契约对齐（任务书 §2.5）：摘要卡成品 ≈300字 ≈900 UTF-8 字节（含原文锚点）。
# delta.result / context.recent_chapters[].summary / chapter_summaries 三处同额——
# 此前 480/360/768 三个互不一致的限额既装不下锚点式摘要，也让同一文本在三处被截成
# 三种长度。delta.result 仍是简短事实速记：完整审读报告写 追踪/运行记录/，不进事务。
SUMMARY_MAX_BYTES = 900

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
# 编排层写完一章后由摘要卡生成 delta.result，commit 时自动入库。
def normalize_chapter_summaries(value: object, last_chapter: int) -> dict[str, str]:
    raw = as_mapping(value, "tracking state.chapter_summaries")
    normalized: dict[str, str] = {}
    for key, summary in raw.items():
        require(isinstance(key, str) and key.isdigit(), f"chapter_summaries key {key!r} must be a chapter number string")
        chapter = int(key)
        require(chapter >= 1, f"chapter_summaries key {key!r} must be >= 1")
        require(chapter <= last_chapter, f"chapter_summaries[{key}] exceeds last_committed_chapter")
        normalized[key] = clean_text(summary, f"chapter_summaries[{key}]", max_bytes=SUMMARY_MAX_BYTES)
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
                    "summary": clean_text(item.get("summary"), f"context.recent_chapters[{index}].summary", max_bytes=SUMMARY_MAX_BYTES),
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
        "result": clean_text(delta.get("result"), "delta.result", max_bytes=SUMMARY_MAX_BYTES),
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


def check_project(project: Path, *, publication_gate: bool = True) -> dict[str, Any]:
    tracking = tracking_root(project)
    require_no_retired_tracking_paths(tracking)
    # D2 发布门在发布器内部最终核验时关闭（journal 此刻确为自身在途发布，complete
    # 只能在最终检查通过之后写——任务书 §2.6）；外部 check/续写预检一律开。
    if publication_gate:
        require_publication_idle(project)
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


# ============================================================
# D2 发布契约（任务书 §2.6：先隔离演练，再提交；中断可恢复）
#
# 单稿也先隔离：候选只在项目 .guyin/work/{run_id}/ 内产生（草稿、只读输入快照、
# 隔离项目、审读/检查记录、run.json），不落正式 正文/ 扫描范围。publish 是唯一
# 正式化入口：prepared 校验授权范围/基线/候选/审读证据/未决阻断后固化全部输入
# 哈希，此后只做机械推进（prose → tracking → fingerprint → complete），不重新
# 摘要、不做语义改写。中断后 recover 绑定同一 run_id 与已固化版本续跑，不越过
# 已完成步骤；超出基线的外部变化一律停用户裁决，不回滚覆盖。
#
# 同步注释契约（D2）：本文件 ProjectLock 与 skills/guyin-write/scripts/
# guyin-check-repetition.js 的 acquireProjectLock 是同一跨语言锁协议的两份实现
# （Python 持锁时经 node --under-lock 调子进程，node 只验锁存在不重入）；
# _publication.json 的消费还有 guyin-setup 模板 hook（publicationBlocker）——
# 三处任改字段/路径语义，其余两处必同步。

PUBLICATION_FILENAME = "_publication.json"
LOCK_DIRNAME = ".track-lock"
LOCK_OWNER_NAME = "owner.json"
WORKSPACE_REL = Path(".guyin/work")
FINGERPRINT_LIB_REL = Path("段落指纹库.json")
IMAGERY_VIEW_REL = Path("意象台账.md")
PUBLISH_SCHEMA_VERSION = 1
PUBLISH_STAGES = (
    "prepared", "prose_written", "tracking_committed", "fingerprint_committed", "complete",
)
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SAFE_REL_RE = re.compile(r"^[^\n\r]+$")


class PublicationError(TrackingError):
    """发布契约违约或发布中断无法自动恢复。"""


class PublishPaused(Exception):
    """GUYIN_PUBLISH_PAUSE_AFTER 演练钩子：journal 已落盘，exit 3 等 recover。"""

    def __init__(self, stage: str, run_id: str):
        super().__init__(f"publish paused after {stage}")
        self.stage = stage
        self.run_id = run_id


# ---------------- 项目级互斥锁（跨语言：目录即锁 + owner.json） ----------------

def _pid_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return True  # 无法判定 → fail-closed 当存活
    if sys.platform == "win32":
        # 禁用 os.kill(pid, 0)：本机实测 Python 3.12 该调用对存活进程也会污染其退出码/
        # 误杀句柄持有者（对测试父进程调用时父进程直接消失）。OpenProcess 只查不发信号：
        # 拿到句柄=存活；GetLastError=87(ERROR_INVALID_PARAMETER)=无此进程；
        # 5(ACCESS_DENIED)=进程存在但无权查询=存活；其余未知 fail-closed。
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            kernel32.CloseHandle(handle)
            return True
        last_error = ctypes.get_last_error()
        if last_error == 87:  # ERROR_INVALID_PARAMETER：系统无此 pid
            return False
        return True  # 5=拒绝访问（存活）；其余 fail-closed
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        return True
    return True


class ProjectLock:
    """commit/backfill/publish/recover/指纹写入共享同一把项目锁。

    协议：mkdir 追踪/.track-lock 原子获取，目录内 owner.json 记录持有者；
    持锁进程死亡（pid 不存在）时，后到者把死锁改名挪走后重试一次。无
    「跳过锁」开关。node 侧同名协议见 guyin-check-repetition.js。
    """

    def __init__(self, project: Path, label: str):
        self.tracking = tracking_root(project)
        self.lock_dir = self.tracking / LOCK_DIRNAME
        self.label = label
        self.held = False

    def _owner_payload(self) -> str:
        return json_payload({
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "label": self.label,
            "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        })

    def _read_owner(self) -> dict[str, Any] | None:
        try:
            doc = json.loads((self.lock_dir / LOCK_OWNER_NAME).read_text(encoding="utf-8"))
            return doc if isinstance(doc, dict) else None
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None

    def acquire(self) -> "ProjectLock":
        self.tracking.mkdir(parents=True, exist_ok=True)
        for _attempt in (1, 2):
            try:
                os.mkdir(self.lock_dir)
                break
            except FileExistsError:
                owner = self._read_owner()
                holder_pid = owner.get("pid") if owner else None
                if isinstance(holder_pid, int) and not _pid_alive(holder_pid):
                    stale = self.lock_dir.with_name(
                        f"{LOCK_DIRNAME}.stale-{int(time.time())}-{os.getpid()}"
                    )
                    try:
                        os.rename(self.lock_dir, stale)
                    except OSError:
                        raise PublicationError(
                            f"项目锁目录无法清理：{self.lock_dir}（持锁进程已死但目录挪不动）"
                            "——请人工检查后删除该目录重试"
                        )
                    shutil.rmtree(stale, ignore_errors=True)
                    continue
                label = (owner or {}).get("label", "未知")
                raise PublicationError(
                    f"项目被占用：{self.lock_dir} 已被另一进程持有（{label}，pid={holder_pid}）。"
                    "同一本书串行提交/发布；确认无其它进程后人工删除该锁目录重试"
                )
        else:
            raise PublicationError("项目锁获取失败（清理陈旧锁后仍被占用）")
        atomic_write_text(self.lock_dir / LOCK_OWNER_NAME, self._owner_payload())
        self.held = True
        return self

    def release(self) -> None:
        if not self.held:
            return
        try:
            os.unlink(self.lock_dir / LOCK_OWNER_NAME)
        except OSError:
            pass
        try:
            os.rmdir(self.lock_dir)
        except OSError:
            shutil.rmtree(self.lock_dir, ignore_errors=True)
        self.held = False

    def __enter__(self) -> "ProjectLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


# ---------------- 哈希 / 路径 / 节点脚本 ----------------

def hash12_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def hash12_file(path: Path) -> str:
    return hash12_bytes(path.read_bytes())


def _resolve_under(project: Path, value: object, label: str) -> Path:
    """清单里的路径：相对路径相对 project 解析；拒绝越出 project 的相对路径。"""
    text = clean_text(value, label, max_bytes=1024)
    p = Path(text)
    resolved = (project / p).resolve() if not p.is_absolute() else p.resolve()
    try:
        resolved.relative_to(project.resolve())
    except ValueError:
        raise PublicationError(f"{label} 越出项目根：{text}")
    return resolved


def _run_node(script_name: str, args: list[str], *, stage: str) -> subprocess.CompletedProcess[str]:
    node = shutil.which("node") or shutil.which("node.exe")
    if node is None:
        raise PublicationError(f"{stage} 需要 node 执行 {script_name}，PATH 中未找到 node——发布门不跳过检查")
    return subprocess.run(
        [node, str(Path(__file__).resolve().parent / script_name), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def _assert_no_pending(project: Path, *, stage: str) -> None:
    ledger = tracking_root(project) / "待审台账.md"
    proc = _run_node(
        "guyin-check-pending.js",
        ["--json", "--project", str(project), str(ledger)],
        stage=stage,
    )
    if proc.returncode == 0:
        return
    tail = (proc.stdout or proc.stderr or "").strip()[:600]
    if proc.returncode == 1:
        raise PublicationError(f"{stage} 拒绝：待审台账存在未决阻断（exit 1）——先逐条转结五终态再发布。\n{tail}")
    raise PublicationError(f"{stage} 拒绝：待审门执行错误（exit 2）——修复台账后重试。\n{tail}")


# ---------------- 发布状态文件（_publication.json） ----------------

def publication_path(project: Path) -> Path:
    return tracking_root(project) / PUBLICATION_FILENAME


def load_publication(project: Path) -> dict[str, Any] | None:
    """读发布状态；不存在返回 None；损坏一律抛错（非 complete 不得静默放行）。"""
    path = publication_path(project)
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublicationError(
            f"发布状态文件损坏：{path}（{exc}）——非 complete 不得静默放行；"
            "人工核查后修复，或显式归档该文件再重新发布"
        )
    if not isinstance(doc, dict) or not isinstance(doc.get("run_id"), str) or doc.get("stage") not in PUBLISH_STAGES:
        raise PublicationError(
            f"发布状态文件形状非法：{path}——缺 run_id 或 stage 不在 {PUBLISH_STAGES}；人工核查，不得猜修"
        )
    return doc


def save_publication(project: Path, journal: dict[str, Any]) -> None:
    atomic_write_text(publication_path(project), json_payload(journal))


def require_publication_idle(project: Path) -> None:
    """check/commit/backfill 消费：非 complete（含损坏）阻断；complete/无文件放行。"""
    doc = load_publication(project)
    if doc is None or doc.get("stage") == "complete":
        return
    raise PublicationError(
        f"存在未完成发布 run_id={doc.get('run_id')}（stage={doc.get('stage')}）："
        "先运行 `tracking-commit.py recover --project <书根>` 完成或恢复，"
        "不得另开提交/发布绕过（任务书 §2.6：普通低层 commit 不能绕过未完成发布）"
    )


# ---------------- 发布清单（发布清单.json）校验 ----------------

def _normalize_manifest(document: object) -> dict[str, Any]:
    root = as_mapping(document, "publish manifest")
    require_known_keys(
        root,
        {
            "schema_version", "run_id", "target", "candidate", "destination", "transaction",
            "baseline", "expected_state_revision", "review", "check_evidence", "run_json",
        },
        "publish manifest",
    )
    require(root.get("schema_version") == PUBLISH_SCHEMA_VERSION, "manifest schema_version is unsupported")
    run_id = clean_text(root.get("run_id"), "run_id", max_bytes=80)
    require(bool(RUN_ID_RE.fullmatch(run_id)), "run_id 须为 1-80 位字母数字 . _ -（首字符字母数字）")

    target = as_mapping(root.get("target"), "target")
    require_known_keys(target, {"chapter", "title", "mode"}, "target")
    chapter = as_int(target.get("chapter"), "target.chapter", minimum=1)
    mode = clean_text(target.get("mode"), "target.mode", max_bytes=24)
    require(mode in {"append", "revision"}, "target.mode must be append or revision")
    title = clean_text(target.get("title"), "target.title", allow_empty=True, max_bytes=240)

    expected_revision = as_int(root.get("expected_state_revision"), "expected_state_revision")

    baseline_raw = as_list(root.get("baseline"), "baseline")
    baseline: list[dict[str, Any]] = []
    for index, item in enumerate(baseline_raw):
        entry = as_mapping(item, f"baseline[{index}]")
        if "path" in entry:
            require_known_keys(entry, {"path", "hash12"}, f"baseline[{index}]")
            rel = clean_text(entry.get("path"), f"baseline[{index}].path", max_bytes=512)
            digest = clean_text(entry.get("hash12"), f"baseline[{index}].hash12", max_bytes=12)
            require(bool(re.fullmatch(r"[0-9a-f]{12}", digest)), f"baseline[{index}].hash12 须为 hash12")
            baseline.append({"kind": "file", "rel": rel, "hash12": digest})
        elif "dir" in entry:
            require_known_keys(entry, {"dir", "files"}, f"baseline[{index}]")
            rel_dir = clean_text(entry.get("dir"), f"baseline[{index}].dir", max_bytes=256)
            files = [clean_text(v, f"baseline[{index}].files[{i}]", max_bytes=256)
                     for i, v in enumerate(as_list(entry.get("files"), f"baseline[{index}].files"))]
            require(len(set(files)) == len(files), f"baseline[{index}].files 有重复成员")
            baseline.append({"kind": "dir", "rel": rel_dir, "files": files})
        else:
            require(False, f"baseline[{index}] 须为 path+hash12 单文件条目或 dir+files 目录条目")

    review = as_mapping(root.get("review"), "review")
    require_known_keys(review, {"mode", "conclusion", "evidence"}, "review")
    review_mode = clean_text(review.get("mode"), "review.mode", max_bytes=120)
    conclusion = clean_text(review.get("conclusion"), "review.conclusion", max_bytes=900)
    evidence = [clean_text(v, f"review.evidence[{i}]", max_bytes=1024)
                for i, v in enumerate(as_list(review.get("evidence", []), "review.evidence"))]
    check_evidence = [clean_text(v, f"check_evidence[{i}]", max_bytes=1024)
                      for i, v in enumerate(as_list(root.get("check_evidence", []), "check_evidence"))]
    run_json = root.get("run_json")
    run_json_rel = clean_text(run_json, "run_json", allow_empty=True, max_bytes=512) if run_json is not None else ""

    return {
        "run_id": run_id,
        "chapter": chapter,
        "title": title,
        "mode": mode,
        "expected_revision": expected_revision,
        "candidate_rel": clean_text(root.get("candidate"), "candidate", max_bytes=1024),
        "destination_rel": clean_text(root.get("destination"), "destination", max_bytes=512),
        "transaction_rel": clean_text(root.get("transaction"), "transaction", max_bytes=1024),
        "baseline": baseline,
        "review_mode": review_mode,
        "conclusion": conclusion,
        "evidence": evidence,
        "check_evidence": check_evidence,
        "run_json_rel": run_json_rel,
    }


def _check_baseline(project: Path, baseline: list[dict[str, Any]]) -> None:
    for entry in baseline:
        if entry["kind"] == "file":
            p = project / entry["rel"]
            if not p.is_file():
                raise PublicationError(f"基线变化：{entry['rel']} 缺失（prepared 基线清单在册）——停用户裁决")
            actual = hash12_file(p)
            if actual != entry["hash12"]:
                raise PublicationError(
                    f"基线变化：{entry['rel']} hash12={actual} ≠ 清单 {entry['hash12']}"
                    "——正式基线已变，拒绝覆盖；重走对照/重建发布"
                )
        else:
            d = project / entry["rel"]
            if not d.is_dir():
                raise PublicationError(f"基线变化：目录 {entry['rel']} 不存在——停用户裁决")
            actual_files = sorted(
                e.name for e in d.iterdir() if e.is_file() and not e.name.startswith(".")
            )
            if actual_files != sorted(entry["files"]):
                added = sorted(set(actual_files) - set(entry["files"]))
                missing = sorted(set(entry["files"]) - set(actual_files))
                raise PublicationError(
                    f"基线变化：{entry['rel']} 成员新增/缺失（新增={added or '无'}，缺失={missing or '无'}）"
                    "——文件新增或缺失也算基线变化，停用户裁决"
                )


def _evidence_bound(project: Path, refs: list[str], candidate_hash: str, label: str) -> None:
    needle = candidate_hash.encode("ascii")
    for ref in refs:
        p = Path(ref)
        if not p.is_absolute():
            p = project / ref
        if not p.is_file():
            raise PublicationError(f"{label}缺失：{ref}（审读/检查证据须真实存在）")
        if needle not in p.read_bytes():
            raise PublicationError(
                f"{label}未绑定候选哈希：{ref} 内容不含 {candidate_hash}——改稿后旧证据自动失效，"
                "证据文件须由绑定当前候选哈希的审读/检查产出"
            )


def _archive_old_prose(project: Path, destination: Path, chapter: int) -> dict[str, str]:
    archive_dir = project / "正文" / "_archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    if re.fullmatch(r"第0*(\d+)章.*\.md", destination.name):
        base = f"第{chapter:03d}章_发布前存档_{stamp}.md"
        collide = f"第{chapter:03d}章_发布前存档_{stamp}_{{suffix}}.md"
    else:
        # F1 短篇篇名文件 revision：存档名带篇名 stem，避免同项目未来多篇互相覆盖。
        stem = destination.stem
        base = f"单元{chapter:03d}_{stem}_发布前存档_{stamp}.md"
        collide = f"单元{chapter:03d}_{stem}_发布前存档_{stamp}_{{suffix}}.md"
    target = archive_dir / base
    suffix = 1
    while target.exists():
        target = archive_dir / collide.format(suffix=suffix)
        suffix += 1
    old_hash = hash12_file(destination)
    shutil.copy2(destination, target)
    return {"rel": target.relative_to(project.resolve()).as_posix(), "hash12": old_hash}


# ---------------- publish 状态机 ----------------

def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _pause_after(stage: str, journal: dict[str, Any]) -> None:
    if os.environ.get("GUYIN_PUBLISH_PAUSE_AFTER") == stage:
        raise PublishPaused(stage, journal["run_id"])


def _stage_prepared(project: Path, m: dict[str, Any], tx_bytes: bytes) -> dict[str, Any]:
    """全部校验通过前不动正式文件；最后存档（revision）并落 journal。"""
    state = load_state(project)
    require(
        state["state_revision"] == m["expected_revision"],
        f"expected_state_revision={m['expected_revision']} 与当前 {state['state_revision']} 不符"
        "——基线已变，重建发布清单",
    )

    candidate = _resolve_under(project, m["candidate_rel"], "candidate")
    workspace = project / WORKSPACE_REL / m["run_id"]
    try:
        candidate.relative_to(workspace.resolve())
    except ValueError:
        raise PublicationError(
            f"候选必须在隔离工作区 {WORKSPACE_REL.as_posix()}/{m['run_id']}/ 内：{m['candidate_rel']}"
            "（单稿也先隔离，候选不落正式 正文/ 扫描范围）"
        )
    if not candidate.is_file():
        raise PublicationError(f"候选正文不存在：{m['candidate_rel']}")
    candidate_hash = hash12_file(candidate)

    destination = _resolve_under(project, m["destination_rel"], "destination")
    try:
        dest_rel = destination.relative_to(project.resolve()).as_posix()
    except ValueError:
        raise PublicationError("destination 越出项目根")
    require(dest_rel.startswith("正文/"), "destination 必须落在 正文/ 下")
    name_match = re.fullmatch(r"第0*(\d+)章.*\.md", destination.name)
    if name_match:
        require(int(name_match.group(1)) == m["chapter"],
                f"destination 文件名章号与 target.chapter={m['chapter']} 不一致：{destination.name}")
    else:
        # F1 短篇最小映射：非章号文件名（正文/{篇名}.md）只允许固定单元 1——首发 append、
        # 重发 revision；单元号在清单里显式给出，不从篇名反解。单元 ≥2 的非章号目标一律拒
        # （同项目多篇须先另定稳定映射与状态隔离，不能靠篇名猜序号）。
        require(destination.name.endswith(".md"), "destination 必须是 .md 文件")
        require(
            m["chapter"] == 1,
            f"非章号文件名仅允许短篇固定单元 1（target.chapter=1）；单元 {m['chapter']} 须先另定"
            f"稳定映射与状态隔离，不靠篇名猜序号：{destination.name}",
        )
    if m["mode"] == "append":
        require(not destination.exists(), f"append 目标已存在：{dest_rel}（修订须走 revision 并先存档）")
    else:
        require(destination.is_file(), f"revision 目标不存在：{dest_rel}（无法修订未发布的章）")

    tx_path = _resolve_under(project, m["transaction_rel"], "transaction")
    require(tx_path.is_file(), f"事务 JSON 不存在：{m['transaction_rel']}")
    require(hash12_bytes(tx_bytes) == hash12_file(tx_path), "内部错误：事务字节固化不一致")
    # 复用现行事务规范化（expected revision / mode / chapter / 字段全检），但不写入。
    normalize_transaction(state, json.loads(tx_bytes.decode("utf-8")))

    _check_baseline(project, m["baseline"])
    if m["run_json_rel"]:
        run_json = _resolve_under(project, m["run_json_rel"], "run_json")
        if run_json.is_file():
            try:
                run_doc = json.loads(run_json.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise PublicationError(f"run.json 不是合法 JSON：{exc}")
            if isinstance(run_doc, dict):
                if run_doc.get("run_id") not in (None, m["run_id"]):
                    raise PublicationError("run.json 的 run_id 与发布清单不一致")
                tgt = run_doc.get("target")
                if isinstance(tgt, dict) and tgt.get("chapter") not in (None, m["chapter"]):
                    raise PublicationError("run.json 的 target.chapter 与发布清单不一致")

    require(m["review_mode"], "review.mode 不能为空（审读模式须明示）")
    require(m["conclusion"], "review.conclusion 不能为空（审读已完成是 prepared 前置）")
    _evidence_bound(project, m["evidence"], candidate_hash, "审读证据")
    _evidence_bound(project, m["check_evidence"], candidate_hash, "检查证据")

    _assert_no_pending(project, stage="prepared")

    archive = _archive_old_prose(project, destination, m["chapter"]) if m["mode"] == "revision" else None

    journal: dict[str, Any] = {
        "schema_version": PUBLISH_SCHEMA_VERSION,
        "run_id": m["run_id"],
        "target": {"chapter": m["chapter"], "title": m["title"], "mode": m["mode"]},
        "stage": "prepared",
        "expected_state_revision": m["expected_revision"],
        "inputs": {
            "candidate": {"rel": candidate.relative_to(project.resolve()).as_posix(), "hash12": candidate_hash},
            "transaction": {"rel": tx_path.relative_to(project.resolve()).as_posix(), "hash12": hash12_bytes(tx_bytes)},
            "destination": dest_rel,
        },
        "archive": archive,
        "steps": {"prepared": {"at": _now_iso(), "state_revision": state["state_revision"]}},
        "final": None,
    }
    save_publication(project, journal)
    _pause_after("prepared", journal)
    return journal


def _write_prose(project: Path, journal: dict[str, Any]) -> None:
    candidate = project / journal["inputs"]["candidate"]["rel"]
    destination = project / journal["inputs"]["destination"]
    candidate_hash = journal["inputs"]["candidate"]["hash12"]
    if not candidate.is_file() or hash12_file(candidate) != candidate_hash:
        raise PublicationError("候选正文缺失或已被改动——恢复绑定同一候选版本，不接受换稿；重建发布")

    def _install() -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        tmp = destination.with_name(f".{destination.name}.publish-{os.getpid()}.tmp")
        with open(tmp, "wb") as fh:
            fh.write(candidate.read_bytes())
        os.replace(tmp, destination)
        if hash12_file(destination) != candidate_hash:
            raise PublicationError("正式正文写入后哈希与候选不一致（磁盘异常）——停用户裁决")

    if destination.exists():
        current = hash12_file(destination)
        if current == candidate_hash:
            pass  # 已安装（journal 落盘前崩溃的重入）：幂等跳过
        elif journal.get("archive") and current == journal["archive"].get("hash12"):
            # revision：prepared 已把这份旧稿存档，现稿正是被存档版本 → 覆盖安装。
            _install()
        else:
            raise PublicationError(
                f"正式正文 {journal['inputs']['destination']} 已存在且内容既非固化候选也非发布前存档版本"
                "——外部改动，停用户裁决"
            )
    else:
        _install()
    journal["stage"] = "prose_written"
    journal["steps"]["prose_written"] = {"at": _now_iso(), "prose_hash12": candidate_hash}
    save_publication(project, journal)
    _pause_after("prose_written", journal)


def _commit_tracking(project: Path, journal: dict[str, Any]) -> None:
    chapter = journal["target"]["chapter"]
    tx_rel = journal["inputs"]["transaction"]["rel"]
    tx_path = project / tx_rel
    if not tx_path.is_file() or hash12_file(tx_path) != journal["inputs"]["transaction"]["hash12"]:
        raise PublicationError("事务 JSON 缺失或已被改动——prepared 后只做机械推进，改事务须重建发布")

    done = journal["steps"].get("tracking_committed")
    state = load_state(project)
    if done is not None:
        # 崩溃在 journal 落盘后：核验已提交成果，不重复 append。
        if state["state_revision"] != done["state_revision"]:
            raise PublicationError(
                f"state_revision={state['state_revision']} 与发布记录 {done['state_revision']} 不符"
                "——追踪被外部改动，停用户裁决，禁止强行回滚"
            )
        if hash12_file(state_path(project)) != done["state_hash12"]:
            raise PublicationError("_tracking-state.json 哈希与发布记录不符——外部改动，停用户裁决")
        views = render_views(state)
        for rel, digest in done["views"].items():
            actual = hash12_bytes(views[rel].encode("utf-8"))
            if actual != digest:
                raise PublicationError(f"派生视图 {rel} 与发布记录不符——停用户裁决")
        return

    # 同一事务经现行唯一通道提交（apply_transaction 内含 expected revision 与全量校验）。
    next_state = apply_transaction(project, json.loads(tx_path.read_text(encoding="utf-8")))
    views = render_views(next_state)
    journal["stage"] = "tracking_committed"
    journal["steps"]["tracking_committed"] = {
        "at": _now_iso(),
        "state_revision": next_state["state_revision"],
        "state_hash12": hash12_file(state_path(project)),
        "views": {rel: hash12_bytes(text.encode("utf-8")) for rel, text in views.items()},
        "chapter": chapter,
    }
    save_publication(project, journal)
    _pause_after("tracking_committed", journal)


def _library_has_chapter(project: Path, chapter: int) -> bool:
    lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
    if not lib_path.is_file():
        return False
    doc = json.loads(lib_path.read_text(encoding="utf-8"))
    return any(isinstance(e, dict) and e.get("chapter") == chapter for e in doc.get("entries", []))


def _library_parse_ok(project: Path) -> bool:
    lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
    if not lib_path.exists():
        return True
    try:
        doc = json.loads(lib_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    return isinstance(doc, dict) and isinstance(doc.get("entries"), list)


def _commit_fingerprint(project: Path, journal: dict[str, Any], *, recovery_mode: bool) -> None:
    chapter = journal["target"]["chapter"]
    done = journal["steps"].get("fingerprint_committed")
    if done is not None:
        lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
        if not lib_path.is_file() or hash12_file(lib_path) != done["library_hash12"]:
            raise PublicationError("段落指纹库与发布记录不符——外部改动，停用户裁决")
        return

    if not _library_parse_ok(project):
        if not recovery_mode:
            raise PublicationError(
                "段落指纹库损坏无法解析：「只补指纹」不成立——中断后用 recover 走受保护恢复"
                "（隔离损坏库＋基线重放＋复检），不得静默重建"
            )
        # F1 短篇单元号：destination 不带「第N章」文件名（单短篇项目固定单元 1）时，
        # 全量重放会漏收篇名文件——按清单里的显式目标文件 + --unit 重放这一篇；
        # 长篇（destination 文件名带章号）仍从 正文/ 全量重放。
        destination = project / journal["inputs"]["destination"]
        if re.search(r"第\s*0*\d+\s*章", destination.name):
            replay_target = project / "正文"
            replay_args = ["--recover-library", "--project", str(project), "--under-lock", str(replay_target)]
        else:
            replay_args = [
                "--recover-library", "--project", str(project), "--under-lock",
                "--unit", str(chapter), str(destination),
            ]
        proc = _run_node(
            "guyin-check-repetition.js",
            replay_args,
            stage="fingerprint recover",
        )
        if proc.returncode != 0:
            raise PublicationError(
                "指纹库受保护恢复失败（exit %d）——恢复不把检测失败冒充通过；输出：\n%s"
                % (proc.returncode, (proc.stdout or proc.stderr or "").strip()[:800])
            )

    if not _library_has_chapter(project, chapter):
        destination = project / journal["inputs"]["destination"]
        # 机械步：advisory/verify 复读裁决在 prepared 前的候选检查已完成（未决台账为空），
        # 此处只固化，不重开语义门（--fail-on=hard；commit 模式欠账门本就跳过）。
        # --unit 显式传目标单元号（F1：短篇篇名文件无章号，不靠文件名反解）。
        proc = _run_node(
            "guyin-check-repetition.js",
            ["--commit", "--fail-on=hard", "--project", str(project), "--under-lock",
             "--unit", str(chapter), str(destination)],
            stage="fingerprint_committed",
        )
        if proc.returncode != 0:
            raise PublicationError(
                f"指纹固化失败（exit {proc.returncode}）——发布停留本阶段，recover 只补指纹不重写正文。\n"
                + (proc.stdout or proc.stderr or "").strip()[:800]
            )
        if not _library_has_chapter(project, chapter):
            raise PublicationError("指纹固化退出成功但库中无本章条目——机械结果矛盾，停用户裁决")

    lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
    imagery_path = tracking_root(project) / IMAGERY_VIEW_REL
    journal["stage"] = "fingerprint_committed"
    journal["steps"]["fingerprint_committed"] = {
        "at": _now_iso(),
        "library_hash12": hash12_file(lib_path),
        "imagery_hash12": hash12_file(imagery_path) if imagery_path.is_file() else None,
    }
    save_publication(project, journal)
    _pause_after("fingerprint_committed", journal)


def _finalize(project: Path, journal: dict[str, Any], *, check_pending: bool) -> None:
    chapter = journal["target"]["chapter"]
    candidate_hash = journal["inputs"]["candidate"]["hash12"]
    destination = project / journal["inputs"]["destination"]
    if not destination.is_file() or hash12_file(destination) != candidate_hash:
        raise PublicationError("最终核验：正式正文缺失或与固化候选不一致——停用户裁决")

    state = check_project(project, publication_gate=False) if check_pending else load_state(project)
    if not check_pending:
        # recover 路径仍须机械核对视图一致性（只是不再跑未决阻断门，任务书 §2.6）。
        expected = render_views(state)
        for rel, text in expected.items():
            p = tracking_root(project) / rel
            if not p.is_file() or p.read_text(encoding="utf-8") != text:
                raise PublicationError(f"最终核验：派生视图不一致：{rel}")
    summary = state.get("chapter_summaries", {}).get(str(chapter))
    require(isinstance(summary, str) and summary != "", "最终核验：本章摘要未入库（正文/摘要必须同版）")

    tracking_done = journal["steps"]["tracking_committed"]
    if state["state_revision"] != tracking_done["state_revision"]:
        raise PublicationError("最终核验：state_revision 与发布记录不符")
    if hash12_file(state_path(project)) != tracking_done["state_hash12"]:
        raise PublicationError("最终核验：state 哈希与发布记录不符")

    fp_done = journal["steps"]["fingerprint_committed"]
    lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
    if not lib_path.is_file() or hash12_file(lib_path) != fp_done["library_hash12"]:
        raise PublicationError("最终核验：段落指纹库缺失或与发布记录不符")
    if not _library_has_chapter(project, chapter):
        raise PublicationError("最终核验：指纹库无本章条目")

    if check_pending:
        _assert_no_pending(project, stage="complete")

    journal["stage"] = "complete"
    journal["final"] = {
        "at": _now_iso(),
        "state_revision": state["state_revision"],
        "prose_hash12": candidate_hash,
        "state_hash12": tracking_done["state_hash12"],
        "library_hash12": fp_done["library_hash12"],
    }
    save_publication(project, journal)


def _drive_publication(project: Path, journal: dict[str, Any], *, recovery_mode: bool) -> dict[str, Any]:
    """按已固化 journal 机械推进；每个已完成阶段先核验再跳过（不越步）。"""
    stage_index = PUBLISH_STAGES.index(journal["stage"])
    if stage_index < PUBLISH_STAGES.index("prose_written"):
        _write_prose(project, journal)
    if journal["stage"] == "prose_written":
        _commit_tracking(project, journal)
    if journal["stage"] == "tracking_committed":
        _commit_fingerprint(project, journal, recovery_mode=recovery_mode)
    if journal["stage"] == "fingerprint_committed":
        _finalize(project, journal, check_pending=not recovery_mode)
    return load_state(project)


def publish(project: Path, manifest_path: Path) -> dict[str, Any]:
    with ProjectLock(project, "publish"):
        document = read_json(manifest_path)
        m = _normalize_manifest(document)
        existing = load_publication(project)
        if existing is not None and existing.get("stage") != "complete":
            if existing.get("run_id") != m["run_id"]:
                raise PublicationError(
                    f"存在未完成发布 run_id={existing.get('run_id')}（stage={existing.get('stage')}）"
                    "：先 recover 收尾，不得另开发布"
                )
            # 同 run_id 重入：按 recover 语义续跑（绑定同一已固化版本）。
            return _drive_publication(project, existing, recovery_mode=False)
        if existing is not None and existing.get("run_id") == m["run_id"]:
            # 同一 run 已 complete：幂等返回，不重复存档/不重建发布。
            return load_state(project)
        tx_path = _resolve_under(project, m["transaction_rel"], "transaction")
        if not tx_path.is_file():
            raise PublicationError(f"事务 JSON 不存在：{m['transaction_rel']}")
        journal = _stage_prepared(project, m, tx_path.read_bytes())
        return _drive_publication(project, journal, recovery_mode=False)


def recover(project: Path) -> dict[str, Any] | None:
    with ProjectLock(project, "recover"):
        journal = load_publication(project)
        if journal is None:
            return None  # 无未完成发布（幂等 no-op）
        if journal.get("stage") == "complete":
            return load_state(project)
        # 损坏形状 load_publication 已抛错；此处绑定同一 run_id/版本续跑。
        return _drive_publication(project, journal, recovery_mode=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("init", "commit", "backfill", "publish"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--project", type=Path, required=True, help="book project root containing 追踪/")
        subparser.add_argument("--input", type=Path, required=True, help="UTF-8 JSON input document")
    for command in ("check", "recover"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--project", type=Path, required=True, help="book project root containing 追踪/")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "init":
            with ProjectLock(args.project, "init"):
                result = initialize(args.project, read_json(args.input))
        elif args.command == "commit":
            with ProjectLock(args.project, "commit"):
                require_publication_idle(args.project)
                result = apply_transaction(args.project, read_json(args.input))
        elif args.command == "backfill":
            with ProjectLock(args.project, "backfill"):
                require_publication_idle(args.project)
                result = backfill_entities(args.project, read_json(args.input))
        elif args.command == "publish":
            result = publish(args.project, args.input)
        elif args.command == "recover":
            recovered = recover(args.project)
            if recovered is None:
                emit(json.dumps({"recover": "no_open_publication"}, ensure_ascii=False))
                return 0
            result = recovered
        else:
            result = check_project(args.project)
    except PublishPaused as paused:
        emit(
            json.dumps(
                {"paused_after": paused.stage, "run_id": paused.run_id,
                 "next": "tracking-commit.py recover --project <书根>"},
                ensure_ascii=False,
            ),
            error=True,
        )
        return 3
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
