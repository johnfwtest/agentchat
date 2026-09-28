#!/usr/bin/env python3
"""AgentChat ↔ OpenClaw 守护适配器（channels/openclaw/，接入说明见同目录 README.md）。

/sync 长轮询收消息 → 被触发时调用本机 OpenClaw 执行 → 结果发回会话并 @ 发送者。
零第三方依赖（urllib + subprocess）。

用法：python3 daemon.py [username] [password]   # 参数可省略，见下

账号解析顺序（省略时逐级回退，任一级拿到非空值即生效）：
  1) 命令行参数
  2) 环境变量 AGENTCHAT_BASE / AGENTCHAT_USER / AGENTCHAT_PASSWORD
  3) .env 文件（KEY=VALUE；查找顺序 $AGENTCHAT_ENV → 本目录 .env → ~/.agentchat/.env）
  4) 凭据文件（JSON：{"username","password","base"(可选)}）：
     $AGENTCHAT_CREDS，否则 ~/.agentchat/creds.json，否则与本文件同目录的 creds.json
  5) 兜底默认 openclaw/pass-openclaw（仅兼容旧部署，会打印告警）

.env 里只填充**尚未设置**的变量，所以真实的进程环境变量始终优先于 .env。
模板见同目录 .env.example；.env 已被 .gitignore 忽略，别把真密码提交上去。

**身份（ME）以登录后服务端返回的账号名为准**，取命令行默认值没有意义：
被 @ 的判定、回复里的 @发送者、跳过自己发的消息，全部基于这个账号名。

其它环境变量：
  AGENTCHAT_BASE  服务地址（默认 http://192.168.1.241:8000，占位示例；.env / 凭据文件里的 base 次之）
  OPENCLAW_CWD    执行 OpenClaw 的工作目录（默认继承守护进程自己的工作目录）
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque

HERE = os.path.dirname(os.path.abspath(__file__))

# 占位默认值（历史部署地址）；.env / 环境变量 / 凭据文件里的 base 会优先覆盖它
DEFAULT_BASE = "http://192.168.1.241:8000"
DEFAULT_USER, DEFAULT_PASSWORD = "openclaw", "pass-openclaw"
CREDS_FILES = [os.path.join(os.path.expanduser("~"), ".agentchat", "creds.json"),
               os.path.join(HERE, "creds.json")]
ENV_FILES = ([os.environ["AGENTCHAT_ENV"]] if os.environ.get("AGENTCHAT_ENV") else []) + [
    os.path.join(HERE, ".env"),
    os.path.join(os.path.expanduser("~"), ".agentchat", ".env"),
]


def parse_env_file(path: str) -> dict[str, str]:
    """解析 KEY=VALUE 形式的 .env：支持空行、# 注释、export 前缀、单双引号。"""
    out: dict[str, str] = {}
    try:
        with open(path) as f:
            lines = f.readlines()
    except OSError:
        return out
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]                      # 引号包裹：原样取值
        elif "#" in val:
            val = val.split("#", 1)[0].strip()    # 无引号：吃掉行尾注释
        out[key] = val
    return out


def load_env_files(paths: list[str]) -> None:
    """.env → 进程环境变量；**已存在的环境变量优先**（不覆盖，保证 真环境变量 > .env）。"""
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        for key, val in parse_env_file(path).items():
            if not os.environ.get(key):
                os.environ[key] = val
        print(f"[env] loaded {path}")


load_env_files(ENV_FILES)

BASE = os.environ.get("AGENTCHAT_BASE") or DEFAULT_BASE
CWD = os.environ.get("OPENCLAW_CWD") or None   # None = 继承守护进程 cwd，不写死路径
ME = None            # 登录后用服务端返回的账号名填充
CRED_CANDIDATES: list[tuple[str, str]] = []   # resolve_creds() 填充，ensure_token 逐组尝试

CURSOR_FILE = os.path.join(HERE, ".cursor")
OC_TIMEOUT = 300                 # 单次 OpenClaw 执行超时
LOOP_WINDOW, LOOP_MAX = 60, 5    # 防循环：每会话 60s 内自动回复上限
RECONCILE_EVERY = 60             # 秒：与服务端快照对账周期（补拉事件流漏掉的消息）

TOKEN = None
reply_times: dict[str, deque] = defaultdict(deque)


def resolve_creds() -> list[tuple[str, str]]:
    """候选凭据列表（按优先级去重）：命令行 > 环境变量（含 .env）> 凭据文件 > 兜底默认。

    ensure_token 逐组尝试登录、第一个成功者生效——systemd 单元命令行里写死的
    旧密码失效后，守护不会卡死，自动落到 .env / 凭据文件里的新密码。
    """
    global BASE
    argv_user = sys.argv[1] if len(sys.argv) > 1 else ""
    argv_pass = sys.argv[2] if len(sys.argv) > 2 else ""

    cfg: dict = {}
    paths = ([os.environ["AGENTCHAT_CREDS"]] if os.environ.get("AGENTCHAT_CREDS") else []) + CREDS_FILES
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                cfg = json.load(f)
            print(f"[creds] loaded {path}")
            break
        except (OSError, ValueError) as e:
            print(f"[creds] {path} 读取失败，已跳过：{e}")
            cfg = {}

    if not os.environ.get("AGENTCHAT_BASE") and cfg.get("base"):
        BASE = cfg["base"]
    candidates: list[tuple[str, str]] = []
    for u, p in ((argv_user, argv_pass),
                 (os.environ.get("AGENTCHAT_USER") or "", os.environ.get("AGENTCHAT_PASSWORD") or ""),
                 (cfg.get("username") or "", cfg.get("password") or "")):
        if u and p and (u, p) not in candidates:
            candidates.append((u, p))
    if not candidates:
        candidates = [(DEFAULT_USER, DEFAULT_PASSWORD)]
        print("[creds] 未找到账号配置，退到内置默认值；建议改用 .env 或凭据文件（见 README）")
    return candidates


def call(method: str, path: str, body=None, timeout=60):
    global TOKEN
    req = urllib.request.Request(BASE + path, method=method)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def ensure_token():
    """逐组候选凭据尝试登录；**身份（ME）以成功那组返回的账号名为准**。"""
    global TOKEN, ME
    last = ""
    for user, password in CRED_CANDIDATES:
        code, r = call("POST", "/api/auth/login", {"username": user, "password": password})
        if code == 200:
            TOKEN = r["token"]
            if ME != r["username"]:
                ME = r["username"]
                print(f"[daemon] identity = {ME}（取自账号）")
            return
        last = f"{user}: {code}"
        print(f"[login] {last}，尝试下一组凭据")
    raise RuntimeError(f"login failed for all candidates ({last})")


def send(conv_id: str, content: str, key: str | None = None) -> str | None:
    """key：幂等键。对触发消息的回复用 f"{ME}-{触发消息id}"——两个 daemon
    实例（升级残留/跨机）回复同一条触发消息时服务端只落地一条（协议级
    防重复处理）；重试同键也幂等。多端 web 的人为发送不带此键，不受影响。"""
    client_msg_id = key or f"{ME}-{time.time_ns()}"
    for attempt in range(3):
        code, r = call("POST", f"/api/convs/{conv_id}/messages",
                       {"content": content, "client_msg_id": client_msg_id})
        if code == 401:
            ensure_token()
            continue
        if code in (200, 201):
            return r["id"]
        print(f"[send] {code} {r}")
        return None
    return None


def run_openclaw(conv_id: str, prompt: str, source: str | None = None) -> str | None:
    """执行 openclaw agent；期间把 stdout 增量经 think 消息流式推给会话
    （API.md 5.5：瞬态不落库，正式回复发出后服务端自动清快照、前端清气泡）。
    即使暂时没有新输出也每 2s 推一次带"已运行 Ns"的快照——在线用户能看到活性。
    """
    import select
    import tempfile
    session = f"agent:main:agentchat-{conv_id[-16:]}"
    started = time.time()
    err_file = tempfile.TemporaryFile(mode="w+")
    try:
        p = subprocess.Popen(
            ["openclaw", "agent", "--session-key", session, "-m", prompt],
            stdout=subprocess.PIPE, stderr=err_file, text=True, cwd=CWD)
    except OSError as e:
        err_file.close()
        print(f"[openclaw] spawn failed: {e}")
        return None

    chunks: list[str] = []
    last_push = 0.0
    deadline = started + OC_TIMEOUT
    fd = p.stdout.fileno()
    while True:
        remain = deadline - time.time()
        if remain <= 0:
            p.kill()
            print("[openclaw] timeout")
            return None
        r, _, _ = select.select([fd], [], [], min(2, remain))
        if r:
            data = os.read(fd, 65536)
            if not data:               # EOF：进程输出结束
                break
            chunks.append(data.decode("utf-8", "replace"))
        now = time.time()
        if now - last_push >= 2:
            tail = "".join(chunks)[-4000:]
            # 诚实文案：OpenClaw CLI 无流式输出（--json 仅最终结果），执行期间
            # stdout 为空，think 实际是"活性心跳"而非思考内容（见 README 说明）
            text = (f"任务执行中…（已运行 {int(now - started)}s）\n"
                    "OpenClaw CLI 暂不支持过程输出，完成即回复结果。")
            if tail:
                text += f"\n{tail}"
            call("PUT", f"/api/convs/{conv_id}/think",
                 {"text": text, "source": source}, timeout=10)
            last_push = now
    out = "".join(chunks).strip()
    rc = p.wait()
    err_file.seek(0)
    err = err_file.read()
    err_file.close()
    if rc != 0:
        print(f"[openclaw] rc={rc} out={out[:100]} err={err[:200]}")
        return None
    # rc=0 且输出为空：模型选择沉默（等价 [[NO_REPLY]]），不是失败
    return out


def loop_limited(conv_id: str) -> bool:
    """60s 窗口内自动回复超过 LOOP_MAX 条则静默（防 Agent 互聊风暴）。"""
    now = time.time()
    q = reply_times[conv_id]
    while q and now - q[0] > LOOP_WINDOW:
        q.popleft()
    if len(q) >= LOOP_MAX:
        return True
    q.append(now)
    return False


def build_prompt(m: dict) -> str:
    """@ 提及与是否回复由 LLM 判断（不机械追加 @sender——那是 agent 互聊
    死循环的永动机：对方也是自动 agent 时，每个 @ 都精确触发它）。
    """
    sender = m.get("sender", "")
    return (
        f"你是内部 IM 系统里的智能助手 {ME}，有人给你发来了消息。"
        "请像同事一样处理，直接输出回复正文（Markdown，会原样发回 IM 会话，不要寒暄）。\n"
        "发言规则：\n"
        "- 你只能通过「输出回复正文」这一种方式说话——不要调用任何消息/发送/通道类"
        "工具（那是别的系统，会失败）。\n"
        "- 判断这条消息不需要回答时，可以不回复——只输出一行 [[NO_REPLY]]；"
        "至少不要 @ 提问者，除非确实需要对方继续做什么（对方也可能是自动 agent，"
        "@ 它可能触发无休止的互答循环）。\n\n"
        f"来自 @{sender} 的消息：\n{m.get('content', '')}"
    )


def is_no_reply(out: str) -> bool:
    """LLM 判定无需回复：输出仅由 [[NO_REPLY]] 标记组成。"""
    lines = [l.strip() for l in out.strip().splitlines() if l.strip()]
    return bool(lines) and all(l == "[[NO_REPLY]]" for l in lines)


def handle(m: dict):
    sender = m.get("sender", "")
    conv_id = m.get("conv_id", "")
    mentions = m.get("mentions") or []
    if sender == ME or m.get("type") != "text":
        return
    is_private = conv_id.startswith("private:")
    if not (is_private or ME in mentions or "all" in mentions):
        return
    if loop_limited(conv_id):
        # 最后兜底（仅拦异常刷屏）：正常交互远达不到；@ 与循环的判断交给 LLM
        print(f"[loop-guard] skip {conv_id}")
        return

    # 👍 已接手回执（fire-and-forget）
    mid = m.get("id")
    if mid:
        call("POST", f"/api/messages/{mid}/reactions", {"emoji": "👍"}, timeout=15)
    # 立刻推一条 think 让用户看到"已接手"（后续由 run_openclaw 持续刷新）
    call("PUT", f"/api/convs/{conv_id}/think",
         {"text": "已接手，正在启动 OpenClaw…", "source": m.get("id")}, timeout=10)

    prompt = build_prompt(m)
    print(f"[task] {sender} -> {conv_id[:30]}: {m.get('content', '')[:60]}")
    result = None
    for attempt in range(3):   # provider 间歇失败（如 auth 抖动）重试，失败调用不耗 token
        result = run_openclaw(conv_id, prompt, source=m.get("id"))
        if result is not None:
            break
        if attempt < 2:
            wait = 5 * (attempt + 1)
            print(f"[retry] openclaw failed, retrying in {wait}s")
            time.sleep(wait)
    if result is None:
        result = "（openclaw 执行失败或超时，请稍后再试或联系管理员）"

    if is_no_reply(result) or not result.strip():
        # LLM 主动选择沉默（[[NO_REPLY]] 或空输出，防循环/无需回复）：不发消息，清掉 think
        print(f"[done] NO_REPLY by LLM in {conv_id[:30]}（不发送）")
        call("PUT", f"/api/convs/{conv_id}/think",
             {"text": "", "source": m.get("id")}, timeout=10)
        return
    # 不再机械追加 @sender：提及由 LLM 在正文中自行判断（防 agent 互聊死循环）
    send(conv_id, result, key=f"{ME}-{m.get('id')}" if m.get("id") else None)
    print(f"[done] replied in {conv_id[:30]}")


# ---------- 游标状态（事件游标 + 每会话已处理到哪条 seq） ----------

def load_state() -> tuple[int | None, dict[str, int]]:
    """读落盘状态：{'cursor': int, 'seqs': {conv_id: last_seq}}；兼容旧的 {'cursor': int}。"""
    try:
        with open(CURSOR_FILE) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, {}
    cursor = data.get("cursor")
    seqs = {str(k): int(v) for k, v in (data.get("seqs") or {}).items()}
    try:
        cursor = None if cursor is None else int(cursor)
    except (TypeError, ValueError):
        cursor = None
    return cursor, seqs


def save_state(cursor: int, seqs: dict[str, int]) -> None:
    """处理完一批事件后才落盘：崩溃降级方向是"重复而非丢失"。"""
    try:
        tmp = CURSOR_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"cursor": cursor, "seqs": seqs}, f)
        os.replace(tmp, CURSOR_FILE)
    except OSError:
        pass


def snapshot() -> tuple[int, list[dict]]:
    """无游标 /api/sync：返回 (服务端当前事件游标, [{conv_id,last_seq}...])。"""
    code, snap = call("GET", "/api/sync")
    if code != 200:
        raise RuntimeError(f"snapshot failed: {code}")
    return int(snap["next_cursor"]), snap["convs"]


def catch_up(seqs: dict[str, int], convs: list[dict]) -> None:
    """按会话从服务端补拉 seqs 之后的消息（每页 100 条）。

    事件流只是"暂存窗口"：服务端重启 / Redis 被清空 / 事件被裁剪时，
    窗口里没有的事件就永远收不到了。真正的真相在 Mongo 的消息表里，
    所以对不上账时按 last_seq 差异补拉，漏掉的任务会被补做（晚到但不丢）。
    """
    for conv in convs:
        cid, last = conv["conv_id"], int(conv.get("last_seq") or 0)
        after = seqs.get(cid)
        if after is None or last <= after:
            continue
        print(f"[catch-up] {cid[:30]}: seq {after} → {last}")
        while True:
            qs = urllib.parse.urlencode({"after_seq": after, "limit": 100})
            code, r = call("GET", f"/api/convs/{cid}/messages?{qs}", timeout=30)
            if code != 200 or not r or not r.get("messages"):
                break
            for m in r["messages"]:
                after = max(after, int(m.get("seq") or 0))
                seqs[cid] = after
                if m.get("sender") != ME:
                    handle(m)
            if not r.get("has_more"):
                break


def acquire_single_instance_lock():
    """单实例锁（防同机双 daemon 双跑）：flock /tmp/agentchat-channel-<ME>.lock。

    只约束**自动化 daemon 进程**——多端登录（两台电脑的网页、人登录 agent
    账号排查/介入）是合法设计，web/人完全不经过这把锁。锁跨用户（/tmp 共享
    路径），进程退出/崩溃自动释放（flock 随 fd 关闭）。升级残留的旧实例没停
    时，新实例在此明确报错退出，而不是双跑导致同一消息被处理两次。
    """
    import fcntl
    path = f"/tmp/agentchat-channel-{ME}.lock"
    fd = open(path, "a+")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fd.seek(0)
        old_pid = fd.read().strip() or "unknown"
        print(f"[lock] 已有 {ME} 的 channel 实例在运行（pid={old_pid}）。"
              "升级请先停旧实例：systemctl stop <服务名>（见 agentchat-channel-*）"
              "或 pkill -f agentchat-channel，再启动本实例。")
        fd.close()
        sys.exit(1)
    fd.seek(0)
    fd.truncate()
    fd.write(str(os.getpid()))
    fd.flush()
    return fd   # 持有到进程退出（不关闭）


def main():
    global CRED_CANDIDATES
    CRED_CANDIDATES = resolve_creds()
    print(f"[daemon] {CRED_CANDIDATES[0][0]}（{len(CRED_CANDIDATES)} 组凭据候选）@ {BASE}，"
          f"启动中（cwd={CWD or os.getcwd()}）")
    ensure_token()
    # fd 必须保持引用（存活的文件对象持有 flock 到进程退出）；
    # 若无引用会被 GC 关闭 fd，锁立即失效
    _lock_fd = acquire_single_instance_lock()  # noqa: F841

    server_cur, convs = snapshot()
    saved, seqs = load_state()
    if saved is not None and saved > server_cur:
        # 服务端事件计数器回退（Redis 被清空 / 服务端重置）：旧游标永远等不到事件，
        # 正是"服务端重启后给 agent 发消息没有回复"的根因。此前的版本会在这里静默卡死。
        print(f"[daemon] 事件游标回退：本地 {saved} > 服务端 {server_cur} —— "
              "事件流被重置，改用按会话补拉（自愈）")
    cursor = saved if (saved is not None and saved <= server_cur) else server_cur

    # 首见会话以当前 last_seq 播种：只补"离开这段时间"的消息，不重放历史
    for conv in convs:
        seqs.setdefault(conv["conv_id"], int(conv.get("last_seq") or 0))
    print(f"[daemon] snapshot: {len(convs)} convs, cursor={cursor}")
    catch_up(seqs, convs)
    save_state(cursor, seqs)

    backoff = 1
    last_reconcile = time.time()
    while True:
        # 定期对账：与服务端快照比对每会话 last_seq，补拉任何事件流没送到我们的消息
        if time.time() - last_reconcile > RECONCILE_EVERY:
            last_reconcile = time.time()
            try:
                server_cur, convs = snapshot()
                catch_up(seqs, convs)
                save_state(cursor, seqs)
            except Exception as e:
                print(f"[reconcile] {type(e).__name__}: {e}")
        try:
            qs = urllib.parse.urlencode({"cursor": cursor, "timeout": 25})
            req = urllib.request.Request(f"{BASE}/api/sync?{qs}")
            req.add_header("Authorization", f"Bearer {TOKEN}")
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            backoff = 1
            if data.get("gap"):
                # 服务端明确告知事件流不连续（窗口裁剪 / 计数器重置）：重新对账
                server_cur, convs = snapshot()
                cursor = server_cur
                for conv in convs:
                    seqs.setdefault(conv["conv_id"], int(conv.get("last_seq") or 0))
                print("[daemon] gap detected, resynced from snapshot")
                catch_up(seqs, convs)
                save_state(cursor, seqs)
                continue
            for ev in data.get("events") or []:
                if ev.get("type") == "message":
                    m = ev["message"]
                    seqs[m["conv_id"]] = max(seqs.get(m["conv_id"], 0),
                                             int(m.get("seq") or 0))
                    handle(m)
                elif ev.get("type") == "kick":
                    print("[daemon] kicked, re-login")
                    ensure_token()
            # 处理完才推进游标：中途崩溃最多重复处理，不会丢消息
            cursor = data["next_cursor"]
            save_state(cursor, seqs)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                ensure_token()
            else:
                print(f"[daemon] HTTP {e.code}, backoff {backoff}s")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        except Exception as e:
            print(f"[daemon] {type(e).__name__}: {e}, backoff {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    main()
