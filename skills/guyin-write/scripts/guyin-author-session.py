#!/usr/bin/env python3
"""guyin-author-session.py — 写作 run 的输入校验、进度指针与中断恢复（任务书 §4.2/§4.4/§5.4）。

只管理 .guyin/work/{run_id}/ 下的输入/进度/文件指针，不生成文本、不评文学、不选模型，
也不提交正式追踪（提交仍由 guyin-tracking-commit.py 负责）。

命令：
  start      --project <B> --run <ID> --input <R/input.json>
  checkpoint --project <B> --run <ID> --input <checkpoint.json>
  status     --project <B> [--run <ID>] [--json]
  repair     --project <B> --run <ID> [--input <R/input.vNNNN.json>] [--draft <R/drafts/vN.md>]

返回码：0=成功/本命令成功（status：ok/resumable），2=输入/状态阻断（status：blocked），3=运行助手 I/O 失败。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent


def _load_tracking() -> Any:
    spec = importlib.util.spec_from_file_location("guyin_tracking_commit", SCRIPT_DIR / "guyin-tracking-commit.py")
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


tk = _load_tracking()
TrackingError = tk.TrackingError
emit = tk.emit

PHASES = ("prepared", "drafting", "drafted", "reviewed", "ready", "published")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_NAME = "author-session.json"
EVIDENCE_KEYS = ("review", "transaction", "check_evidence", "plan_patch")
EVIDENCE_EMBED_KEYS = ("review", "check_evidence")  # 这两类证据正文须内嵌候选 hash12


class SessionError(ValueError):
    """输入/状态阻断（exit 2）。"""


class SessionIOError(RuntimeError):
    """助手自身 I/O 失败（exit 3）。"""


# ---------------- 基础工具 ----------------

def sha256_bytes(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel_posix(path: Path) -> str:
    return path.as_posix()


def resolve_under(base: Path, value: str, label: str, *, must_exist: bool = True) -> Path:
    """解析相对 base 的真实路径，拒绝越界与符号链接。"""
    if not isinstance(value, str) or not value:
        raise SessionError(f"{label} 必须是非空相对路径")
    p = Path(value)
    if p.is_absolute() or "\x00" in value:
        raise SessionError(f"{label} 必须是相对书根的路径：{value}")
    parts = p.parts
    if any(part in ("..",) for part in parts):
        raise SessionError(f"{label} 不得包含 ..：{value}")
    abs_path = base / p
    try:
        abs_path.resolve(strict=False).relative_to(base.resolve(strict=False))
    except ValueError as exc:
        raise SessionError(f"{label} 越出书根：{value}") from exc
    if must_exist:
        if not abs_path.is_file():
            raise SessionError(f"{label} 不是可读常规文件：{value}")
        if abs_path.is_symlink():
            raise SessionError(f"{label} 拒绝符号链接：{value}")
    return abs_path


def atomic_write_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except OSError as exc:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise SessionIOError(f"原子写入失败 {path}: {exc}") from exc


def read_json_file(path: Path, label: str) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise SessionError(f"{label} 不是合法 JSON：{exc}") from exc
    if not isinstance(doc, dict):
        raise SessionError(f"{label} 必须是 JSON 对象")
    return doc


def is_hex64(value: object) -> bool:
    return isinstance(value, str) and bool(HEX64_RE.fullmatch(value))


# ---------------- input.json v1 校验（§4.2） ----------------

def validate_input(doc: dict[str, Any], project: Path, *, label: str = "input") -> dict[str, Any]:
    if doc.get("schema_version") != 1:
        raise SessionError(f"{label}.schema_version 必须为 1")
    allowed = {"schema_version", "target", "authorization", "sources", "facts", "locks",
               "allowed_reuse", "outline", "style", "wordcount"}
    unknown = set(doc) - allowed
    if unknown:
        raise SessionError(f"{label} 含未知字段：{', '.join(sorted(unknown))}")

    target = doc.get("target")
    if not isinstance(target, dict):
        raise SessionError(f"{label}.target 必须是对象")
    if target.get("kind") not in ("long", "short"):
        raise SessionError(f"{label}.target.kind 只允许 long/short")
    chapter = target.get("chapter")
    if not isinstance(chapter, int) or isinstance(chapter, bool) or chapter < 1:
        raise SessionError(f"{label}.target.chapter 必须是正整数")
    title = target.get("title")
    if not isinstance(title, str) or not title or title in (".", "..") or "/" in title or "\\" in title:
        raise SessionError(f"{label}.target.title 必须是合法单个文件名组件")
    if any(ord(c) < 32 for c in title):
        raise SessionError(f"{label}.target.title 含控制字符")
    if target.get("mode") not in ("append", "revision"):
        raise SessionError(f"{label}.target.mode 只允许 append/revision")

    sources_list = doc.get("sources")
    if not isinstance(sources_list, list) or not sources_list:
        raise SessionError(f"{label}.sources 至少要有一条来源（缺输入文件≠零锁）")
    source_ids: set[str] = set()
    sources_norm: dict[str, dict[str, Any]] = {}
    for i, raw in enumerate(sources_list):
        if not isinstance(raw, dict):
            raise SessionError(f"{label}.sources[{i}] 必须是对象")
        sid = raw.get("id")
        if not isinstance(sid, str) or not sid:
            raise SessionError(f"{label}.sources[{i}].id 缺失")
        if sid in source_ids:
            raise SessionError(f"{label}.sources 来源 id 重复：{sid}")
        kind = raw.get("kind")
        if kind == "user":
            text = raw.get("text")
            if not isinstance(text, str) or not text.strip():
                raise SessionError(f"{label}.sources[{sid}] user 来源必须有真实原话 text")
            sources_norm[sid] = {"id": sid, "kind": "user", "text": text}
        elif kind == "file":
            fpath = raw.get("path")
            abs_path = resolve_under(project, fpath, f"{label}.sources[{sid}].path")
            observed = sha256_file(abs_path)
            given = raw.get("sha256")
            if given is not None:
                if not is_hex64(given):
                    raise SessionError(f"{label}.sources[{sid}].sha256 必须是 64 位小写十六进制")
                if given != observed:
                    raise SessionError(f"{label}.sources[{sid}] 文件哈希与登记不符（登记 {given[:12]} 实际 {observed[:12]}）")
            entry = {"id": sid, "kind": "file", "path": fpath.replace("\\", "/"), "sha256": observed}
            if raw.get("locator") is not None:
                if not isinstance(raw.get("locator"), str):
                    raise SessionError(f"{label}.sources[{sid}].locator 必须是字符串")
                entry["locator"] = raw["locator"]
            sources_norm[sid] = entry
        else:
            raise SessionError(f"{label}.sources[{sid}].kind 只允许 user/file")
        source_ids.add(sid)

    def source_text(sid: object) -> str:
        if sid not in sources_norm:
            raise SessionError(f"{label} 引用了不存在的来源 id：{sid}")
        s = sources_norm[sid]
        if s["kind"] == "user":
            return s["text"]
        try:
            return Path(s["path"]).read_text(encoding="utf-8") if False else (project / s["path"]).read_text(encoding="utf-8")
        except OSError:
            return ""

    def require_quote(sid: object, quote: object, where: str) -> None:
        if sid not in sources_norm:
            raise SessionError(f"{label}.{where} 的 source_id 不存在：{sid}")
        if sources_norm[sid]["kind"] != "user":
            raise SessionError(f"{label}.{where} 必须指向 kind=user 的真实记录：{sid}")
        if not isinstance(quote, str) or not quote:
            raise SessionError(f"{label}.{where}.quote 必须是非空原话")
        if quote not in sources_norm[sid]["text"]:
            raise SessionError(f"{label}.{where}.quote 无法在来源 {sid} 的原话中定位")

    auth = doc.get("authorization")
    if not isinstance(auth, dict):
        raise SessionError(f"{label}.authorization 必须是对象")
    write_auth = auth.get("write")
    if not isinstance(write_auth, dict):
        raise SessionError(f"{label}.authorization.write 必须是对象（写作授权不能省）")
    require_quote(write_auth.get("source_id"), write_auth.get("quote"), "authorization.write")
    selection = auth.get("selection")
    if selection is not None:
        if not isinstance(selection, dict):
            raise SessionError(f"{label}.authorization.selection 只允许 null 或对象")
        require_quote(selection.get("source_id"), selection.get("quote"), "authorization.selection")
        if not is_hex64(selection.get("candidate_sha256")):
            raise SessionError(f"{label}.authorization.selection.candidate_sha256 必须是 64 位哈希")
    publish_auth = auth.get("publish")
    if publish_auth is not None:
        if not isinstance(publish_auth, dict):
            raise SessionError(f"{label}.authorization.publish 只允许 null 或对象")
        require_quote(publish_auth.get("source_id"), publish_auth.get("quote"), "authorization.publish")
        scope = publish_auth.get("scope")
        if scope not in ("selected-candidate", "authorized-target"):
            raise SessionError(f"{label}.authorization.publish.scope 非法")
        cand_hash = publish_auth.get("candidate_sha256")
        if scope == "selected-candidate":
            if not is_hex64(cand_hash):
                raise SessionError(f"{label}.authorization.publish selected-candidate 必须给当前候选 64 位 SHA-256")
        elif cand_hash is not None and not is_hex64(cand_hash):
            raise SessionError(f"{label}.authorization.publish candidate_sha256 只允许 null 或 64 位哈希")
        pub_target = publish_auth.get("target")
        if not isinstance(pub_target, dict):
            raise SessionError(f"{label}.authorization.publish.target 必须是精确匹配对象")
        for key in ("kind", "chapter", "title", "mode"):
            if key in pub_target and pub_target[key] != target[key]:
                raise SessionError(f"{label}.authorization.publish.target.{key} 与本 run 目标不一致")

    locks = doc.get("locks", [])
    if not isinstance(locks, list):
        raise SessionError(f"{label}.locks 必须是数组（无锁写 []）")
    for i, lock in enumerate(locks):
        if not isinstance(lock, dict) or lock.get("kind") not in ("exact", "semantic", "forbidden"):
            raise SessionError(f"{label}.locks[{i}].kind 只允许 exact/semantic/forbidden")
        if lock.get("source_id") not in source_ids:
            raise SessionError(f"{label}.locks[{i}].source_id 不存在——模型不得自造硬锁")
        if not isinstance(lock.get("text"), str) or not lock["text"].strip():
            raise SessionError(f"{label}.locks[{i}].text 不能为空")
        lid = lock.get("id")
        if lid is not None and not isinstance(lid, str):
            raise SessionError(f"{label}.locks[{i}].id 必须是字符串")

    facts = doc.get("facts", [])
    if not isinstance(facts, list):
        raise SessionError(f"{label}.facts 必须是数组")
    for i, fact in enumerate(facts):
        if not isinstance(fact, dict) or not isinstance(fact.get("text"), str) or not fact["text"].strip():
            raise SessionError(f"{label}.facts[{i}].text 不能为空")
        if fact.get("source_id") not in source_ids:
            raise SessionError(f"{label}.facts[{i}].source_id 不存在")

    reuse = doc.get("allowed_reuse", [])
    if not isinstance(reuse, list) or not all(isinstance(x, str) and x for x in reuse):
        raise SessionError(f"{label}.allowed_reuse 必须是字符串数组")

    outline = doc.get("outline")
    if outline is not None:
        if not isinstance(outline, dict) or set(outline) != {"path", "sha256"}:
            raise SessionError(f"{label}.outline 只能是 null 或 {{path, sha256}}")
        abs_outline = resolve_under(project, outline["path"], f"{label}.outline.path")
        if not is_hex64(outline["sha256"]) or sha256_file(abs_outline) != outline["sha256"]:
            raise SessionError(f"{label}.outline.sha256 非法或与文件不符")

    style = doc.get("style")
    if not isinstance(style, dict):
        raise SessionError(f"{label}.style 必须是对象")
    if not isinstance(style.get("profile_id"), str) or not style["profile_id"]:
        raise SessionError(f"{label}.style.profile_id 缺失")
    pv = style.get("profile_version")
    if not isinstance(pv, int) or isinstance(pv, bool) or pv < 1:
        raise SessionError(f"{label}.style.profile_version 必须是正整数")
    if style.get("selection_basis") not in ("framework-default", "user-selected"):
        raise SessionError(f"{label}.style.selection_basis 只允许 framework-default/user-selected")
    feats = style.get("effective_features")
    if not isinstance(feats, list) or not feats or not all(isinstance(x, str) and x for x in feats):
        raise SessionError(f"{label}.style.effective_features 必须是非空字符串数组")

    wc = doc.get("wordcount")
    if not isinstance(wc, dict):
        raise SessionError(f"{label}.wordcount 必须是对象")
    wmin, wmax = wc.get("min"), wc.get("max")
    for name_, value_ in (("min", wmin), ("max", wmax)):
        if not isinstance(value_, int) or isinstance(value_, bool) or value_ < 1:
            raise SessionError(f"{label}.wordcount.{name_} 必须是正整数")
    if wmin > wmax:
        raise SessionError(f"{label}.wordcount.min 不得大于 max")

    return doc


# ---------------- 基线 ----------------

def work_rel(project: Path, abs_path: Path) -> str:
    return abs_path.resolve(strict=False).relative_to(project.resolve(strict=False)).as_posix()


def list_prose_files(project: Path) -> list[dict[str, str]]:
    prose_dir = project / "正文"
    if not prose_dir.is_dir():
        return []
    out: list[dict[str, str]] = []
    for root, dirs, files in os.walk(prose_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            abs_path = Path(root) / name
            if abs_path.is_symlink():
                raise SessionError(f"正文目录拒绝符号链接：{name}")
            out.append({"path": work_rel(project, abs_path), "sha256": sha256_file(abs_path)})
    return sorted(out, key=lambda e: e["path"])


def build_baseline(project: Path, state: dict[str, Any], input_doc: dict[str, Any]) -> dict[str, Any]:
    state_abs = tk.state_path(project)
    baseline: dict[str, Any] = {
        "state_revision": state["state_revision"],
        "state": {"path": "追踪/_tracking-state.json", "sha256": sha256_file(state_abs)},
        "prose": {"dir": "正文", "files": list_prose_files(project)},
        "sources": [],
    }
    seen: set[str] = set()
    for raw in input_doc.get("sources", []):
        if raw.get("kind") != "file":
            continue
        rel = raw["path"].replace("\\", "/")
        if rel in seen:
            continue
        seen.add(rel)
        baseline["sources"].append({"path": rel, "sha256": raw["sha256"]})
    return baseline


def precheck_project(project: Path, run_id: str) -> None:
    """start 前置：追踪 check + pending + 在途发布。"""
    try:
        tk.check_project(project)
    except TrackingError as exc:
        raise SessionError(f"tracking check 未过：{exc}") from exc
    try:
        existing = tk.load_publication(project)
    except TrackingError as exc:
        raise SessionError(f"发布账本损坏，先人工核对/recover：{exc}") from exc
    if existing is not None and existing.get("stage") != "complete":
        if existing.get("run_id") != run_id:
            raise SessionError(
                f"存在在途发布 run_id={existing.get('run_id')}（stage={existing.get('stage')}）："
                "先 tracking-commit.py recover 收尾，不得另开 run")
        raise SessionError(
            f"本 run 存在在途发布（stage={existing.get('stage')}）：先 recover，再用同名 run 继续，不重新 start")
    pending_js = SCRIPT_DIR / "guyin-check-pending.js"
    ledger = project / "追踪" / "待审台账.md"
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise SessionError("找不到 node：无法跑 pending 预检")
    if ledger.is_file():
        proc = subprocess.run([node, str(pending_js), "--project", str(project), str(ledger)],
                              capture_output=True, text=True, encoding="utf-8")
        if proc.returncode != 0:
            detail = (proc.stdout + proc.stderr).strip()[:400]
            raise SessionError(f"pending 预检未过（待审台账有当前版本未决行，先消费）：{detail}")


# ---------------- 会话文件 ----------------

def session_path(project: Path, run_id: str) -> Path:
    return project / ".guyin" / "work" / run_id / SESSION_NAME


def run_dir(project: Path, run_id: str) -> Path:
    return project / ".guyin" / "work" / run_id


def load_session(project: Path, run_id: str) -> dict[str, Any]:
    path = session_path(project, run_id)
    if not path.is_file():
        raise SessionError(f"run 不存在：{run_id}（{path}）")
    doc = read_json_file(path, "author-session.json")
    required = {"schema_version", "run_id", "input_path", "input_sha256", "phase", "baseline", "draft"}
    missing = required - set(doc)
    if missing or doc.get("run_id") != run_id or doc.get("phase") not in PHASES:
        raise SessionError("author-session.json 形状非法")
    return doc


def evidence_entry(project: Path, session: dict[str, Any], rel: str, key: str) -> dict[str, Any] | None:
    abs_path = resolve_under(project, rel, f"{key} 路径")
    draft = session.get("draft")
    if not draft:
        raise SessionError(f"登记 {key} 前必须先登记 draft")
    candidate_sha = draft["sha256"]
    if key in EVIDENCE_EMBED_KEYS:
        text = abs_path.read_text(encoding="utf-8", errors="replace")
        if candidate_sha[:12] not in text:
            raise SessionError(f"{key} 内容未嵌入当前候选 hash12（{candidate_sha[:12]}），拒绝绑旧稿/空证")
    return {"path": rel.replace("\\", "/"), "sha256": sha256_file(abs_path), "candidate_sha256": candidate_sha}


# ---------------- start ----------------

def cmd_start(project: Path, run_id: str, input_path: str) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise SessionError("run_id 非法：1-80 位字母/数字/点/下划线/连字符，首字符为字母数字")
    if not (project / "追踪").is_dir():
        raise SessionError(f"书根缺 追踪/ 目录：{project}")
    state = tk.load_state(project)  # 缺 state 直接抛错：先 init/修复，不造 0
    rdir = run_dir(project, run_id)
    spath = session_path(project, run_id)
    if spath.is_file():
        existing = read_json_file(spath, "author-session.json")
        input_abs = resolve_under(project, input_path, "input 路径")
        digest = sha256_file(input_abs)
        if existing.get("input_sha256") == digest:
            return {"note": "同名 run 已存在且输入一致：start 幂等返回，不覆盖", "session": existing}
        raise SessionError("同名 run 已存在但输入不同：禁止覆盖；恢复旧 run 或另取 run_id")
    precheck_project(project, run_id)
    input_abs = resolve_under(project, input_path, "input 路径")
    input_doc = validate_input(read_json_file(input_abs, "input"), project)
    digest = sha256_file(input_abs)
    (rdir / "drafts").mkdir(parents=True, exist_ok=True)
    session = {
        "schema_version": 1,
        "run_id": run_id,
        "input_path": input_path.replace("\\", "/"),
        "input_sha256": digest,
        "phase": "prepared",
        "baseline": build_baseline(project, state, input_doc),
        "draft": None,
        "review": None,
        "transaction": None,
        "check_evidence": None,
        "plan_patch": None,
        "next_action": None,
    }
    atomic_write_json(spath, session)
    return {"started": run_id, "phase": "prepared", "input_sha256": digest,
            "baseline_state_revision": session["baseline"]["state_revision"]}


# ---------------- checkpoint ----------------

def _draft_entry(project: Path, rdir: Path, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("path"), str):
        raise SessionError("checkpoint.draft 必须是 {path, complete}")
    complete = raw.get("complete")
    if not isinstance(complete, bool):
        raise SessionError("checkpoint.draft.complete 必须是布尔")
    abs_path = resolve_under(project, raw["path"], "draft.path")
    try:
        rel_to_run = abs_path.resolve(strict=False).relative_to(rdir.resolve(strict=False))
    except ValueError as exc:
        raise SessionError(f"draft 路径必须在当前 run 目录内：{raw['path']}") from exc
    if rel_to_run.parts[0] != "drafts":
        raise SessionError(f"持久候选版本必须位于 R/drafts/ 下：{raw['path']}")
    data = abs_path.read_bytes()
    if not data.strip():
        raise SessionError("draft 文件为空，不允许登记")
    return {"path": raw["path"].replace("\\", "/"), "complete": complete, "sha256": sha256_bytes(data)}


def _artifact_supports(phase: str, draft: dict[str, Any] | None, session: dict[str, Any]) -> bool:
    if phase in ("prepared", "drafting"):
        return draft is not None
    if phase == "drafted":
        return bool(draft and draft.get("complete"))
    if phase == "reviewed":
        return bool(draft and draft.get("complete") and session.get("review"))
    if phase == "ready":
        return bool(draft and draft.get("complete") and session.get("transaction") and session.get("check_evidence"))
    return False


def _published_consistent(project: Path, run_id: str, draft: dict[str, Any] | None) -> bool:
    try:
        journal = tk.load_publication(project)
    except TrackingError:
        return False
    if not journal or journal.get("stage") != "complete" or journal.get("run_id") != run_id:
        return False
    dest = (journal.get("inputs") or {}).get("destination") or journal.get("destination_rel")
    if not dest or not draft:
        return False
    dest_abs = (project / dest)
    return dest_abs.is_file() and sha256_file(dest_abs) == draft["sha256"]


def cmd_checkpoint(project: Path, run_id: str, cp_input: str) -> dict[str, Any]:
    session = load_session(project, run_id)
    rdir = run_dir(project, run_id)
    doc = read_json_file(resolve_under(project, cp_input, "checkpoint 输入"), "checkpoint")
    allowed = {"phase", "draft", "review", "transaction", "check_evidence",
               "plan_patch", "next_action", "input_path"}
    unknown = set(doc) - allowed
    if unknown:
        raise SessionError(f"checkpoint 含未知键：{', '.join(sorted(unknown))}")

    # --- 输入修订（发布前补授权的唯一路径）---
    if doc.get("input_path"):
        return _apply_input_revision(project, run_id, session, doc["input_path"])

    if session["phase"] == "published":
        for key in ("phase", "draft", "review", "transaction", "check_evidence"):
            if key in doc and doc[key] is not None:
                raise SessionError("published 阶段只允许登记 plan_patch 与 next_action")
        if "plan_patch" in doc:
            session["plan_patch"] = None if doc["plan_patch"] is None else evidence_entry(
                project, session, doc["plan_patch"], "plan_patch")
        if "next_action" in doc:
            na = doc["next_action"]
            if na is not None and (not isinstance(na, str) or not na.strip()):
                raise SessionError("next_action 必须是非空字符串或 null")
            session["next_action"] = na
        atomic_write_json(session_path(project, run_id), session)
        return {"run_id": run_id, "phase": "published", "note": "同阶段登记"}

    new_phase = doc.get("phase")
    if new_phase not in PHASES:
        raise SessionError("checkpoint.phase 缺失或非法")

    # draft 登记
    draft_changed = False
    if "draft" in doc and doc["draft"] is not None:
        entry = _draft_entry(project, rdir, doc["draft"])
        old = session.get("draft")
        if not old or old["sha256"] != entry["sha256"] or old["path"] != entry["path"]:
            draft_changed = True
        session["draft"] = entry
    elif "draft" in doc and doc["draft"] is None:
        raise SessionError("draft 不允许显式置 null（用新版本换稿，不删登记）")
    draft = session["draft"]

    # 换稿/后退：四种证据立即失效（无论调用方传什么）
    moving_back = PHASES.index(new_phase) < PHASES.index(session["phase"])
    invalidate = False
    if draft_changed and new_phase in ("drafting", "drafted") and moving_back:
        invalidate = True
    if draft_changed and session["phase"] in ("drafted", "reviewed", "ready") and new_phase in ("drafting", "drafted"):
        invalidate = True
    if invalidate:
        for key in EVIDENCE_KEYS:
            session[key] = None

    # 证据登记（未失效才接受）
    for key in EVIDENCE_KEYS:
        if key not in doc:
            continue
        if invalidate:
            continue
        raw = doc[key]
        session[key] = None if raw is None else evidence_entry(project, session, raw, key)

    # 状态机
    old_phase = session["phase"]
    if new_phase != old_phase:
        if new_phase == "published":
            if not _published_consistent(project, run_id, draft):
                raise SessionError("只有 publish 账本 complete、run 与目标稿核对一致后才能记 published")
        elif new_phase == "blocked":
            pass  # 任意非 published 阶段可进 blocked
        elif old_phase == "blocked":
            if not _artifact_supports(new_phase, draft, session):
                raise SessionError(f"blocked 解除只能凭实际文件回到支持的阶段：{new_phase} 证据不足")
        elif moving_back:
            if new_phase not in ("drafting", "drafted") or not invalidate:
                raise SessionError(f"非法回退 {old_phase}→{new_phase}：仅换稿可退 drafting/drafted 并失效证据")
        else:
            if not _artifact_supports(new_phase, draft, session):
                raise SessionError(f"前进到 {new_phase} 的产物不齐（complete 稿/回看/事务/机器证据）")

    if "next_action" in doc:
        na = doc["next_action"]
        if na is not None and (not isinstance(na, str) or not na.strip()):
            raise SessionError("next_action 必须是非空字符串或 null")
        session["next_action"] = na

    session["phase"] = new_phase
    atomic_write_json(session_path(project, run_id), session)
    return {"run_id": run_id, "phase": new_phase, "draft": draft and draft["sha256"][:12],
            "invalidated_evidence": invalidate}


def _apply_input_revision(project: Path, run_id: str, session: dict[str, Any], new_input_rel: str) -> dict[str, Any]:
    new_abs = resolve_under(project, new_input_rel, "修订 input 路径")
    rdir = run_dir(project, run_id)
    if not new_abs.resolve(strict=False).relative_to(rdir.resolve(strict=False)):
        raise SessionError("修订输入必须另存为当前 R 内的 input.vNNNN.json")
    new_doc = validate_input(read_json_file(new_abs, "修订 input"), project, label="input(修订)")
    old_doc = validate_input(read_json_file(project / session["input_path"], project), project, label="input(旧)")
    if new_doc["target"] != old_doc["target"]:
        raise SessionError("目标（kind/chapter/title/mode）或正式基线变化：必须新开 run，不能换输入硬过门")
    # selected-candidate / 用户选稿授权绑定具体候选：换稿即失效，不得拿旧授权套新稿
    draft = session.get("draft")
    if draft:
        for field_name in ("selection", "publish"):
            auth_obj = new_doc["authorization"].get(field_name)
            if isinstance(auth_obj, dict) and is_hex64(auth_obj.get("candidate_sha256")):
                if auth_obj["candidate_sha256"] != draft["sha256"]:
                    raise SessionError(
                        f"authorization.{field_name} 绑定的候选与当前登记稿不一致：换稿后该授权失效，"
                        "须由用户就新稿重新授权（authorized-target 才可给 null）")
    state = tk.load_state(project)
    if state["state_revision"] != session["baseline"]["state_revision"]:
        raise SessionError("基线已变化时不能修订输入：先核发布账本/开新 run")
    if sha256_file(tk.state_path(project)) != session["baseline"]["state"]["sha256"]:
        raise SessionError("追踪状态文件已被外部修改：blocked，不能修订输入")
    digest = sha256_file(new_abs)
    session["input_path"] = new_input_rel.replace("\\", "/")
    session["input_sha256"] = digest
    for key in EVIDENCE_KEYS:
        session[key] = None
    draft = session.get("draft")
    session["phase"] = "drafted" if draft and draft.get("complete") else "drafting"
    atomic_write_json(session_path(project, run_id), session)
    return {"run_id": run_id, "phase": session["phase"], "input_sha256": digest,
            "note": "输入已修订，四种证据清空，凭新授权重新核对；目标/基线未变"}


# ---------------- status ----------------

def discover_runs(project: Path) -> list[str]:
    root = project / ".guyin" / "work"
    if not root.is_dir():
        return []
    out = []
    for entry in sorted(root.iterdir()):
        if entry.is_dir() and (entry / SESSION_NAME).is_file():
            out.append(entry.name)
    return out


def _draft_version(name: str) -> int | None:
    m = re.fullmatch(r"v(\d+)\.md", name)
    return int(m.group(1)) if m else None


def _orphan_drafts(project: Path, session: dict[str, Any]) -> list[str]:
    """版本号高于当前登记稿的 vNNNN.md 才是“未登记新稿”；更早版本是受保护历史。"""
    drafts_dir = run_dir(project, session["run_id"]) / "drafts"
    if not drafts_dir.is_dir():
        return []
    registered = session.get("draft")
    cur_ver: int | None = None
    if registered:
        cur_ver = _draft_version(Path(registered["path"]).name)
    out = []
    for p in sorted(drafts_dir.glob("v*.md")):
        ver = _draft_version(p.name)
        rel = work_rel(project, p)
        if ver is None:
            if rel != (registered or {}).get("path"):
                out.append(rel)
            continue
        # 无登记稿：全部算未登记；有登记稿：只报更高版本（中断新写）
        if cur_ver is None or ver > cur_ver:
            if rel != (registered or {}).get("path"):
                out.append(rel)
    return out


def cmd_status(project: Path, run_id: str | None) -> dict[str, Any]:
    if run_id is None:
        runs = discover_runs(project)
        if not runs:
            raise SessionError("没有任何 run（.guyin/work/*/author-session.json）")
        if len(runs) > 1:
            raise SessionError(f"存在多个未完成 run，必须显式 --run 指定：{', '.join(runs)}")
        run_id = runs[0]
    spath = session_path(project, run_id)
    if not spath.is_file():
        return {"status": "blocked", "run_id": run_id,
                "reasons": ["session 缺失：用 repair --input/--draft 按可核验产物重建，不猜恢复点"],
                "next_action": "guyin-author-session.py repair --project <B> --run " + run_id}
    try:
        session = read_json_file(spath, "author-session.json")
        if session.get("run_id") != run_id or session.get("phase") not in PHASES:
            raise ValueError("shape")
    except (SessionError, ValueError):
        return {"status": "blocked", "run_id": run_id,
                "reasons": ["author-session.json 不可解析：损坏会话先 repair（原始字节会原样保存）"],
                "next_action": "guyin-author-session.py repair --project <B> --run " + run_id}

    reasons: list[str] = []
    rdir = run_dir(project, run_id)

    def under_run(rel: str) -> Path:
        return resolve_under(project, rel, "session 指针")

    input_abs = under_run(session["input_path"])
    if not input_abs.is_file() or sha256_file(input_abs) != session["input_sha256"]:
        reasons.append("input 文件缺失或哈希与 session 不符")

    draft = session.get("draft")
    if draft:
        dabs = under_run(draft["path"])
        if not dabs.is_file():
            reasons.append(f"已登记稿件不存在：{draft['path']}")
        elif sha256_file(dabs) != draft["sha256"]:
            reasons.append(f"已登记稿件被外部修改：{draft['path']}")

    for key in EVIDENCE_KEYS:
        e = session.get(key)
        if not e:
            continue
        abs_e = under_run(e["path"])
        if not abs_e.is_file():
            reasons.append(f"{key} 证据文件缺失：{e['path']}")
        elif sha256_file(abs_e) != e["sha256"]:
            reasons.append(f"{key} 证据被修改：{e['path']}")
        elif draft and e.get("candidate_sha256") != draft["sha256"]:
            reasons.append(f"{key} 绑定的是另一候选，证据失效")

    # 发布账本
    publication: dict[str, Any] | None = None
    try:
        publication = tk.load_publication(project)
    except TrackingError as exc:
        reasons.append(f"发布账本损坏：{exc}")
    if publication and publication.get("run_id") == run_id and publication.get("stage") != "complete":
        reasons.append(f"本 run 发布在途（{publication.get('stage')}）：只走 tracking-commit recover")

    # baseline：state 变化须能由本 run 的 complete 发布解释，否则是外部改动
    baseline = session.get("baseline") or {}
    state_changed = False
    state_abs = tk.state_path(project)
    if state_abs.is_file() and sha256_file(state_abs) != (baseline.get("state") or {}).get("sha256"):
        state_changed = True
    explained_by_publish = state_changed and _published_consistent(project, run_id, draft)
    if state_changed and not explained_by_publish:
        reasons.append("baseline 追踪状态相对本 run 已变化且无本 run complete 发布可解释：外部改动，blocked")

    # 正文成员基线
    current_prose = list_prose_files(project)
    base_prose = {(f["path"], f["sha256"]) for f in (baseline.get("prose") or {}).get("files", [])}
    current_set = {(f["path"], f["sha256"]) for f in current_prose}
    if not explained_by_publish:
        for item in sorted(current_set - base_prose):
            reasons.append(f"正文出现基线外/被改成员：{item[0]}")
        for item in sorted(base_prose - current_set):
            reasons.append(f"正文基线成员消失：{item[0]}")

    # 书内来源文件
    for src in baseline.get("sources", []):
        abs_src = project / src["path"]
        if not abs_src.is_file() or sha256_file(abs_src) != src["sha256"]:
            reasons.append(f"本 run 实际读取的书内来源已变化：{src['path']}")

    orphans = _orphan_drafts(project, session)
    if orphans:
        reasons.append("存在未登记孤立新稿（显式登记或弃用，不自动按新旧选稿）：" + "、".join(orphans))

    blocked = bool([r for r in reasons if "在途" not in r and "孤立新稿" not in r]) or any(
        "在途" in r for r in reasons)
    status = "blocked" if (reasons and blocked) else ("resumable" if orphans or session["phase"] != "ready" else "ok")
    if not reasons and session["phase"] == "ready":
        status = "ok"
    elif not reasons:
        status = "resumable"
    return {
        "status": status, "run_id": run_id, "phase": session["phase"],
        "input": {"path": session["input_path"], "sha256": session["input_sha256"][:12]},
        "draft": draft and {"path": draft["path"], "sha256": draft["sha256"][:12], "complete": draft["complete"]},
        "review": bool(session.get("review")), "transaction": bool(session.get("transaction")),
        "check_evidence": bool(session.get("check_evidence")), "plan_patch": bool(session.get("plan_patch")),
        "baseline_state_revision": baseline.get("state_revision"),
        "publication_stage": publication.get("stage") if publication else None,
        "orphan_drafts": orphans, "reasons": reasons,
        "next_action": session.get("next_action"),
    }


# ---------------- repair ----------------

def cmd_repair(project: Path, run_id: str, input_rel: str | None, draft_rel: str | None) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise SessionError("run_id 非法")
    spath = session_path(project, run_id)
    if spath.is_file():
        try:
            existing = read_json_file(spath, "author-session.json")
            if existing.get("run_id") == run_id and existing.get("phase") in PHASES:
                raise SessionError("有效 session 已存在：repair 仅用于缺失/不可解析，禁止覆盖有效记录")
        except SessionError as exc:
            if "有效 session" in str(exc):
                raise

    rdir = run_dir(project, run_id)
    rdir.mkdir(parents=True, exist_ok=True)
    if spath.is_file():
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        preserved = rdir / f"session.corrupt-{stamp}.json"
        preserved.write_bytes(spath.read_bytes())
    else:
        preserved = None

    input_rel = input_rel or f".guyin/work/{run_id}/input.json"
    input_abs = resolve_under(project, input_rel, "repair input")
    input_doc = validate_input(read_json_file(input_abs, "repair input"), project)
    digest = sha256_file(input_abs)

    journal = None
    try:
        journal = tk.load_publication(project)
    except TrackingError as exc:
        raise SessionError(f"发布账本损坏，repair 中止：{exc}") from exc
    if journal and journal.get("run_id") != run_id and journal.get("stage") != "complete":
        raise SessionError(f"另一 run（{journal.get('run_id')}）发布在途：先 recover，不重建本 run")

    (rdir / "drafts").mkdir(exist_ok=True)
    draft_entry: dict[str, Any] | None = None
    if draft_rel:
        d_abs = resolve_under(project, draft_rel, "repair draft")
        if d_abs.resolve(strict=False).relative_to(rdir.resolve(strict=False)).parts[0] != "drafts":
            raise SessionError("repair --draft 必须指向 R/drafts/ 内版本")
        draft_entry = {"path": draft_rel.replace("\\", "/"), "complete": False, "sha256": sha256_file(d_abs)}

    phase = "drafting"
    note: list[str] = []
    if preserved:
        note.append(f"损坏原文已存 {preserved.name}")
    if journal and journal.get("stage") == "complete" and journal.get("run_id") == run_id:
        phase = "published"
        dest = (journal.get("inputs") or {}).get("destination") or journal.get("destination_rel")
        chosen = None
        for p in sorted((rdir / "drafts").glob("v*.md")):
            if dest and (project / dest).is_file() and sha256_file(project / dest) == sha256_file(p):
                chosen = p
                break
        if chosen and not draft_entry:
            draft_entry = {"path": work_rel(project, chosen), "complete": True, "sha256": sha256_file(chosen)}
        note.append("按 complete 发布账本重建 published")
    elif journal and journal.get("run_id") == run_id:
        raise SessionError("本 run 发布在途：只用 tracking-commit recover，repair 不重建在途状态")

    def ev_if_bound(key: str, fname: str, embed: bool) -> dict[str, Any] | None:
        if not draft_entry:
            return None
        p = rdir / fname
        if not p.is_file():
            return None
        if embed and draft_entry["sha256"][:12] not in p.read_text(encoding="utf-8", errors="replace"):
            return None
        return {"path": f".guyin/work/{run_id}/{fname}", "sha256": sha256_file(p),
                "candidate_sha256": draft_entry["sha256"]}

    session = {
        "schema_version": 1, "run_id": run_id,
        "input_path": input_rel.replace("\\", "/"), "input_sha256": digest,
        "phase": phase,
        "baseline": None,  # 无法从旧记录证明基线；published 终态由发布账本兜底
        "draft": draft_entry,
        "review": ev_if_bound("review", "review.md", True),
        "transaction": ev_if_bound("transaction", "transaction.json", False),
        "check_evidence": ev_if_bound("check_evidence", "check-evidence.json", True),
        "plan_patch": None,
        "next_action": ("published 终态：核对后续章/规划补丁" if phase == "published"
                        else "baseline 无法证明：请用户确认后从 drafting/drafted 继续"),
        "repaired": True,
        "repair_note": note,
    }
    atomic_write_json(spath, session)
    return {"repaired": run_id, "phase": phase, "baseline": None,
            "draft": draft_entry and draft_entry["path"], "note": note}


# ---------------- CLI ----------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="写作 run 进度助手")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("start")
    s.add_argument("--project", required=True)
    s.add_argument("--run", required=True)
    s.add_argument("--input", required=True)
    c = sub.add_parser("checkpoint")
    c.add_argument("--project", required=True)
    c.add_argument("--run", required=True)
    c.add_argument("--input", required=True)
    st = sub.add_parser("status")
    st.add_argument("--project", required=True)
    st.add_argument("--run")
    r = sub.add_parser("repair")
    r.add_argument("--project", required=True)
    r.add_argument("--run", required=True)
    r.add_argument("--input")
    r.add_argument("--draft")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project = Path(args.project).resolve()
    try:
        if args.command == "start":
            result = cmd_start(project, args.run, args.input)
        elif args.command == "checkpoint":
            result = cmd_checkpoint(project, args.run, args.input)
        elif args.command == "status":
            result = cmd_status(project, args.run)
            blocked = result.get("status") == "blocked"
            emit(json.dumps(result, ensure_ascii=False, indent=2))
            return 2 if blocked else 0
        elif args.command == "repair":
            result = cmd_repair(project, args.run, args.input, args.draft)
        else:  # pragma: no cover
            return 2
        emit(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except SessionError as exc:
        emit(json.dumps({"error": str(exc)}, ensure_ascii=False), error=True)
        return 2
    except (OSError, UnicodeError) as exc:
        emit(json.dumps({"io_error": str(exc)}, ensure_ascii=False), error=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
