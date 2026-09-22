import io, sys

p = r"skills/guyin-write/scripts/guyin-author-session.py"
with io.open(p, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 定位 repair 主体（从 "(rdir / \"drafts\").mkdir" 到 "            \"draft\": draft_entry and ..." return 结束）
start = next(i for i, l in enumerate(lines) if '(rdir / "drafts").mkdir(exist_ok=True)' in l)
# return 块终点：cmd_repair 的最后一个 return（含 note）
end = None
for i in range(start, len(lines)):
    if '"draft": draft_entry and draft_entry["path"], "note": note}' in lines[i]:
        end = i
        break
assert end is not None, "repair return not found"

new_block = '''    (rdir / "drafts").mkdir(exist_ok=True)
    note: list[str] = []
    if preserved:
        note.append(f"损坏原文已存 {preserved.name}")

    def make_draft_entry(rel: str, complete: bool) -> dict[str, Any]:
        d_abs = resolve_under(project, rel, "repair draft")
        if d_abs.resolve(strict=False).relative_to(rdir.resolve(strict=False)).parts[0] != "drafts":
            raise SessionError("repair --draft 必须指向 R/drafts/ 内版本")
        return {"path": rel.replace("\\\\", "/"), "complete": complete, "sha256": sha256_file(d_abs)}

    # --- 分支一：本 run 有 complete 发布账本——按固化目标/候选/正文核验重建 published ---
    if journal and journal.get("stage") == "complete" and journal.get("run_id") == run_id:
        inputs = journal.get("inputs") or {}
        cand_rel = (inputs.get("candidate") or {}).get("rel")
        cand_h12 = (inputs.get("candidate") or {}).get("hash12")
        dest_rel = inputs.get("destination")
        if not cand_rel or not cand_h12 or not dest_rel:
            raise SessionError("complete 发布账本缺固化 candidate/destination，不凭猜测重建 published")
        cand_abs = resolve_under(project, cand_rel, "journal candidate")
        if not cand_abs.is_file():
            raise SessionError(f"固化候选缺失：{cand_rel}——不凭碰巧同哈希的文件拼 published")
        if sha256_file(cand_abs)[:12] != cand_h12:
            raise SessionError("固化候选内容与账本 hash12 不符：不伪造 published，停人工核对")
        dest_abs = project / dest_rel
        if not dest_abs.is_file() or sha256_file(dest_abs) != sha256_file(cand_abs):
            raise SessionError(f"正式正文 {dest_rel} 与固化候选不一致：不伪造 after，停人工核对")
        tgt = journal.get("target") or {}
        if input_doc.get("target", {}).get("chapter") != tgt.get("chapter") \\
                or input_doc.get("target", {}).get("mode") != tgt.get("mode"):
            raise SessionError("repair input.target 与发布账本固化 target 不一致：不拼 published")
        draft_entry = make_draft_entry(cand_rel, True)
        session = {
            "schema_version": 1, "run_id": run_id,
            "input_path": input_rel.replace("\\\\", "/"), "input_sha256": digest,
            "phase": "published", "baseline": None,
            "draft": draft_entry,
            "review": None, "transaction": None, "check_evidence": None, "plan_patch": None,
            "next_action": "published 终态：核对后续章/规划补丁",
            "repaired": True,
            "repair_note": note + ["按 complete 发布账本固化候选/目标核验重建 published"],
        }
        atomic_write_json(spath, session)
        return {"repaired": run_id, "phase": "published", "baseline": None,
                "draft": draft_entry["path"], "note": session["repair_note"]}

    if journal and journal.get("run_id") == run_id:
        raise SessionError("本 run 发布在途：只用 tracking-commit recover，repair 不重建在途状态")

    # --- 分支二：无 complete 账本——基线不可证明，一律 blocked、complete=false、证据全清；
    # 不猜最新稿：--draft 只登记用户明确指向的版本并标未完成，获准重新取材后另开 run。
    draft_entry = make_draft_entry(draft_rel, False) if draft_rel else None
    if draft_entry:
        note.append(f"登记候选 {draft_entry['path']}（complete=false，不猜最新稿）")
    session = {
        "schema_version": 1, "run_id": run_id,
        "input_path": input_rel.replace("\\\\", "/"), "input_sha256": digest,
        "phase": "blocked",
        "baseline": None,
        "draft": draft_entry,
        "review": None, "transaction": None, "check_evidence": None, "plan_patch": None,
        "next_action": "基线无法证明：获准重新取材后另开 run；或补齐可核验产物后从 blocked 解除",
        "repaired": True,
        "repair_note": note + ["无 complete 发布账本：建 blocked/baseline=null/complete=false，旧证据未复用"],
    }
    atomic_write_json(spath, session)
    return {"repaired": run_id, "phase": "blocked", "baseline": None,
            "draft": draft_entry and draft_entry["path"], "note": session["repair_note"]}
'''

# 保持原文件换行风格
# 检测原文件用什么换行
sample = "".join(lines[:200])
nl = "\r\n" if "\r\n" in sample else "\n"
out = lines[:start] + [new_block.replace("\n", nl)] + lines[end+1:]
with io.open(p, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)
print("patched", start + 1, end + 1)
