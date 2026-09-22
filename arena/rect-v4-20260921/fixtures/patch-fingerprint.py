import io

p = r"skills/guyin-write/scripts/guyin-tracking-commit.py"
with io.open(p, "r", encoding="utf-8", newline="") as f:
    lines = f.readlines()

s = next(i for i, l in enumerate(lines) if l.startswith("def _commit_fingerprint("))
e = next(i for i in range(s, len(lines)) if lines[i].startswith("def _finalize(")) - 1
while lines[e].strip() == "":
    e -= 1
print("range", s + 1, e + 1, repr(lines[s][-2:]))

new = '''FP_ARTIFACT_RELS = ("追踪/段落指纹库.json", "追踪/意象台账.md")


def _fp_plan_artifacts(journal: dict[str, Any]) -> list[dict[str, Any]]:
    return [a for a in _plan_artifacts(journal) if a.get("path") in FP_ARTIFACT_RELS]


def _fp_classify(project: Path, journal: dict[str, Any]) -> str:
    """指纹库/意象两产物的当前盘面分类（任一第三态即 third）。"""
    states = set()
    for art in _fp_plan_artifacts(journal):
        pp = project / art["path"]
        cur = sha256_file(pp) if pp.is_file() else None
        after = art.get("after_sha256")
        if after is None:
            states.add("pending")  # 尚未产生 after（首次未跑到指纹阶段）
        elif cur == after:
            states.add("after")
        elif cur == art.get("before_sha256"):
            states.add("before")
        else:
            states.add("third")
    if "third" in states:
        return "third"
    if states == {"after"}:
        return "all_after"
    return "not_after"


def _run_fp_commit(project: Path, journal: dict[str, Any]) -> None:
    """机械固化：同章替换（revision 也必跑，不看章号在否）。"""
    chapter = journal["target"]["chapter"]
    destination = project / journal["inputs"]["destination"]
    proc = _run_node(
        "guyin-check-repetition.js",
        ["--commit", "--fail-on=hard", "--project", str(project), "--under-lock",
         "--unit", str(chapter), str(destination)],
        stage="fingerprint_committed",
    )
    if proc.returncode != 0:
        raise PublicationError(
            f"指纹固化失败（exit {proc.returncode}）——发布停留本阶段，recover 只补指纹不重写正文。\\n"
            + (proc.stdout or proc.stderr or "").strip()[:800]
        )


def _stage_fp_after(project: Path, journal: dict[str, Any]) -> None:
    """读盘上实际指纹产物，暂存进 R 并回填 tracking_plan 的 after/staged。"""
    stage_dir = project / WORKSPACE_REL / journal["run_id"] / "publication" / "artifacts"
    stage_dir.mkdir(parents=True, exist_ok=True)
    for art in _fp_plan_artifacts(journal):
        rel = art["path"]
        pp = project / rel
        if not pp.is_file():
            # 意象台账在无比喻时仍由 commit 渲染（通常存在）；确实无文件时 after=before=null 合法。
            if art.get("before_sha256") is not None:
                raise PublicationError(f"指纹阶段后产物缺失：{rel}——保留现场，停人工核对")
            art["after_sha256"] = None
            art["staged_path"] = None
            continue
        data = pp.read_bytes()
        staged = stage_dir / rel.replace("/", "__")
        staged.write_bytes(data)
        art["after_sha256"] = hashlib.sha256(data).hexdigest()
        art["staged_path"] = staged.relative_to(project.resolve()).as_posix()
    journal["tracking_plan"]["artifacts"] = [
        a for a in _plan_artifacts(journal) if a.get("path") not in FP_ARTIFACT_RELS
    ] + _fp_plan_artifacts(journal)


def _verify_fp_owner(project: Path, journal: dict[str, Any]) -> None:
    """B-3：库内目标章条目必须全部由当前正式稿（固化候选）生成。"""
    chapter = journal["target"]["chapter"]
    destination = project / journal["inputs"]["destination"]
    proc = _run_node(
        "guyin-check-repetition.js",
        ["--verify-owner", "--json", "--project", str(project),
         "--unit", str(chapter), str(destination)],
        stage="fingerprint verify-owner",
    )
    if proc.returncode != 0:
        raise PublicationError(
            "指纹归属核验失败：库内目标章存在不由当前候选生成的条目（revision 必须替换旧指纹）；"
            f"输出：{(proc.stdout or proc.stderr or '').strip()[:500]}"
        )


def _commit_fingerprint(project: Path, journal: dict[str, Any], *, recovery_mode: bool) -> None:
    chapter = journal["target"]["chapter"]
    lib_path = tracking_root(project) / FINGERPRINT_LIB_REL
    imagery_path = tracking_root(project) / IMAGERY_VIEW_REL
    done = journal["steps"].get("fingerprint_committed")

    if done is not None:
        # journal 已记录：库/意象必须等于记录，且全部 tracking_plan 产物为 after——不重跑、零新增。
        if not lib_path.is_file() or hash12_file(lib_path) != done["library_hash12"]:
            raise PublicationError("段落指纹库与发布记录不符——外部改动，停用户裁决")
        img_now = hash12_file(imagery_path) if imagery_path.is_file() else None
        if img_now != done.get("imagery_hash12"):
            raise PublicationError("意象台账与发布记录不符——外部改动，停用户裁决")
        if _classify_plan_state(project, journal) != "all_after" or _fp_classify(project, journal) != "all_after":
            raise PublicationError("指纹阶段已标记完成但追踪/指纹产物非全部 after——第三态，停用户裁决")
        return

    fp_state = _fp_classify(project, journal)
    if fp_state == "all_after":
        # 指纹实际已写完、journal 未更新（精确崩溃窗口）：只补记，零写入。
        pass
    elif fp_state == "not_after":
        # 库损坏时的受保护恢复（仅 recover 路径允许重放；新发布阶段损坏一律阻断）。
        if not _library_parse_ok(project):
            if not recovery_mode:
                raise PublicationError(
                    "段落指纹库损坏无法解析：中断后用 recover 走受保护恢复"
                    "（隔离损坏库＋基线重放＋复检），不得静默重建")
            destination = project / journal["inputs"]["destination"]
            if re.search(r"第\\s*0*\\d+\\s*章", destination.name):
                replay_args = ["--recover-library", "--project", str(project), "--under-lock",
                               str(project / "正文")]
            else:
                replay_args = ["--recover-library", "--project", str(project), "--under-lock",
                               "--unit", str(chapter), str(destination)]
            proc = _run_node("guyin-check-repetition.js", replay_args, stage="fingerprint recover")
            if proc.returncode != 0:
                raise PublicationError(
                    "指纹库受保护恢复失败（exit %d）——不冒充通过；输出：\\n%s"
                    % (proc.returncode, (proc.stdout or proc.stderr or "").strip()[:800]))
        # B-3：无论首装还是 revision 都执行同章替换（旧逻辑的「章号存在即跳过」已废除）。
        _run_fp_commit(project, journal)
        _stage_fp_after(project, journal)
    else:
        raise PublicationError(
            "指纹库/意象台账出现第三种内容（既非 before 也非固化 after）——外部改动，停用户裁决")

    # 归属核验：目标章条目必须由当前候选生成（revision 旧稿指纹不得残留）。
    _verify_fp_owner(project, journal)

    journal["stage"] = "fingerprint_committed"
    journal["steps"]["fingerprint_committed"] = {
        "at": _now_iso(),
        "library_hash12": hash12_file(lib_path),
        "imagery_hash12": hash12_file(imagery_path) if imagery_path.is_file() else None,
    }
    save_publication(project, journal)
    _pause_after("fingerprint_committed", journal)

'''

nl = "\r\n" if lines[s].endswith("\r\n") else "\n"
out = lines[:s] + [new.replace("\n", nl)] + lines[e + 1:]
with io.open(p, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)
print("patched _commit_fingerprint")
