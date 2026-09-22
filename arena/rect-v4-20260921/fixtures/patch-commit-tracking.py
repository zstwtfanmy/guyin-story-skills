import io

p = r"skills/guyin-write/scripts/guyin-tracking-commit.py"
with io.open(p, "r", encoding="utf-8", newline="") as f:
    lines = f.readlines()

s = next(i for i, l in enumerate(lines) if l.startswith("def _commit_tracking("))
e = next(i for i in range(s, len(lines)) if lines[i].startswith("def _library_has_chapter(")) - 1
# 去掉尾部空行
while lines[e].strip() == "":
    e -= 1
print("range", s + 1, e + 1, repr(lines[s][-2:]))

new = '''def _plan_artifacts(journal: dict[str, Any]) -> list[dict[str, Any]]:
    return (journal.get("tracking_plan") or {}).get("artifacts", [])


def _classify_plan_state(project: Path, journal: dict[str, Any]) -> str:
    """按 tracking_plan 把当前盘面对每个产物分类：all_before/all_after/mixed/third。"""
    states = set()
    for art in _plan_artifacts(journal):
        pp = project / art["path"]
        cur = sha256_file(pp) if pp.is_file() else None
        if cur == art.get("after_sha256"):
            states.add("after")
        elif cur == art.get("before_sha256"):
            states.add("before")
        else:
            states.add("third")
    if "third" in states:
        return "third"
    if states == {"after"}:
        return "all_after"
    if states == {"before"}:
        return "all_before"
    return "mixed"


def _commit_tracking(project: Path, journal: dict[str, Any]) -> None:
    chapter = journal["target"]["chapter"]
    tx_rel = journal["inputs"]["transaction"]["rel"]
    tx_path = project / tx_rel
    if not tx_path.is_file() or hash12_file(tx_path) != journal["inputs"]["transaction"]["hash12"]:
        raise PublicationError("事务 JSON 缺失或已被改动——prepared 后只做机械推进，改事务须重建发布")

    done = journal["steps"].get("tracking_committed")
    plan_state = _classify_plan_state(project, journal)

    if done is not None:
        # journal 已记录 tracking_committed：只接受全盘 after；第三态/半成品零新增写入（G-3/G-4）。
        if plan_state != "all_after":
            raise PublicationError(
                f"tracking 已标记提交但产物状态={plan_state}（非全部 after）——第三态/半成品现场，"
                "停用户裁决，不重 append、不覆盖、不回滚")
        state = load_state(project)
        if state["state_revision"] != done["state_revision"]:
            raise PublicationError(
                f"state_revision={state['state_revision']} 与发布记录 {done['state_revision']} 不符"
                "——追踪被外部改动，停用户裁决，禁止强行回滚")
        if hash12_file(state_path(project)) != done["state_hash12"]:
            raise PublicationError("_tracking-state.json 哈希与发布记录不符——外部改动，停用户裁决")
        return

    # journal 尚未记录（含「state 已写、journal 未更新」精确崩溃窗口，G-3/T29）。
    if plan_state == "all_after":
        next_state = load_state(project)
    elif plan_state == "all_before":
        # 干净未提交：纯内存预演复核（与 apply 同一套规则），按暂存字节安装，state 最后原子落盘。
        state = load_state(project)
        require(
            state["state_revision"] == journal["expected_state_revision"],
            f"expected_state_revision={journal['expected_state_revision']} 与当前 {state['state_revision']} 不符"
            "——基线已变，重建发布",
        )
        sim = simulate_transaction(state, json.loads(tx_path.read_text(encoding="utf-8")))
        next_state = sim["next_state"]
        delta_rel = delta_path(tracking_root(project), chapter).relative_to(project.resolve()).as_posix()
        expected = {"追踪/_tracking-state.json": sim["next_state_payload"]}
        for rel, text in sim["views"].items():
            expected[rel] = text
        expected[delta_rel] = sim["delta_payload"]
        for art in _plan_artifacts(journal):
            rel = art["path"]
            if rel in expected and hashlib.sha256(expected[rel].encode("utf-8")).hexdigest() != art.get("after_sha256"):
                raise PublicationError(f"暂存预期字节与当前预演不一致：{rel}——prepared 计划已失效，重建发布")
        for art in _plan_artifacts(journal):
            rel = art["path"]
            if rel == "追踪/_tracking-state.json" or rel not in expected:
                continue
            target_p = project / rel
            target_p.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(target_p, expected[rel])
        atomic_write_text(state_path(project), expected["追踪/_tracking-state.json"])
        # T29 故障注入：state 已原子落盘、journal 尚未更新——真实终止独立子进程（非异常/非 exit3）。
        if os.environ.get("GUYIN_PUBLISH_CRASH_AFTER") == "state_write":
            os._exit(9)
    elif plan_state == "mixed":
        raise PublicationError("tracking 产物部分已写部分未写（mixed 现场）——不允许半套提交，停用户裁决")
    else:
        raise PublicationError(
            "tracking 产物出现第三种内容（既非 before 也非 after）——外部改动，停用户裁决，"
            "不回滚、不覆盖、不重 append")

    if _classify_plan_state(project, journal) != "all_after":
        raise PublicationError("内部错误：tracking 写入后产物未全部等于 after——保留现场，停人工核对")
    journal["stage"] = "tracking_committed"
    journal["steps"]["tracking_committed"] = {
        "at": _now_iso(),
        "state_revision": next_state["state_revision"],
        "state_hash12": hash12_file(state_path(project)),
        "views": {art["path"]: art["after_sha256"] for art in _plan_artifacts(journal)
                  if art["path"].startswith("追踪/") and art["path"] != "追踪/_tracking-state.json"
                  and art["path"] not in ("追踪/段落指纹库.json", "追踪/意象台账.md")},
        "chapter": chapter,
    }
    save_publication(project, journal)
    _pause_after("tracking_committed", journal)
'''

nl = "\r\n" if lines[s].endswith("\r\n") else "\n"
out = lines[:s] + [new.replace("\n", nl)] + lines[e + 1:]
with io.open(p, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)
print("patched _commit_tracking")
