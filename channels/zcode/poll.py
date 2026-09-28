#!/usr/bin/env python3
"""zcode 守护：拉取 AgentChat 待处理消息（cron 驱动 ZCode 会话调用）。

用法：python3 agentchat-poll.py
输出：JSON 数组（待处理消息）或 []。触发条件、过滤、防循环在脚本层保证。
配置（优先级从高到低）：环境变量 AGENTCHAT_* → .env（$AGENTCHAT_ENV → 本目录 .env →
~/.zcode/.env → ~/.agentchat/.env）→ 凭据文件 ~/.zcode/agentchat-creds.json → 兜底默认。
token 过期自动重登。模板见同目录 .env.example。
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE_FALLBACK = "http://192.168.1.241:8000"
HOME = os.path.expanduser("~/.zcode")
HERE = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE = f"{HOME}/agentchat-creds.json"
TOKEN_FILE = f"{HOME}/agentchat-token"
CURSOR_FILE = f"{HOME}/agentchat-cursor.json"
PENDING_FILE = f"{HOME}/agentchat-pending.json"
SKIP_SENDERS = {"openclaw"}          # 防 agent 互聊循环
MAX_PER_RUN = 3


# ---- 配置加载：.env → 进程环境变量（已存在的不覆盖，真环境变量优先）---------
def _parse_env(path):
    """解析 KEY=VALUE 形式的 .env：支持空行、# 注释、export 前缀、单双引号。"""
    out = {}
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
        if not key or not (key[0].isalpha() or key[0] == "_") \
                or not all(c.isalnum() or c == "_" for c in key):
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]                    # 引号包裹：原样取值
        elif "#" in val:
            val = val.split("#", 1)[0].strip()  # 无引号：吃掉行尾注释
        out[key] = val
    return out


for _p in (os.environ.get("AGENTCHAT_ENV"), f"{HERE}/.env", f"{HOME}/.env",
           os.path.expanduser("~/.agentchat/.env")):
    if not _p or not os.path.isfile(_p):
        continue
    for _k, _v in _parse_env(_p).items():
        if not os.environ.get(_k):
            os.environ[_k] = _v

BASE = os.environ.get("AGENTCHAT_BASE") or BASE_FALLBACK
ME = None           # 登录后用服务端返回的账号名填充（身份以账号名为准）


def _creds():
    """账号密码：环境变量（含 .env）> ~/.zcode/agentchat-creds.json > 兜底默认。"""
    user = os.environ.get("AGENTCHAT_USER") or ""
    password = os.environ.get("AGENTCHAT_PASSWORD") or ""
    if not (user and password) and os.path.isfile(CREDS_FILE):
        try:
            with open(CREDS_FILE) as f:
                cfg = json.load(f)
            user = user or cfg.get("username") or ""
            password = password or cfg.get("password") or ""
        except (OSError, ValueError):
            pass
    return user or "zcode", password or "pass-zcode"

_token = None


def call(method, path, body=None, timeout=30):
    global _token
    req = urllib.request.Request(BASE + path, method=method)
    if _token:
        req.add_header("Authorization", f"Bearer {_token}")
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def ensure_token():
    global _token, ME
    if os.path.exists(TOKEN_FILE):
        _token = open(TOKEN_FILE).read().strip()
        code, me = call("GET", "/api/me")
        if code == 200:
            ME = (me or {}).get("username") or ME
            return
    user, password = _creds()
    code, r = call("POST", "/api/auth/login",
                   {"username": user, "password": password})
    if code != 200:
        print(json.dumps({"error": f"login failed: {r}"}))
        sys.exit(1)
    _token = r["token"]
    ME = r.get("username") or user
    with open(TOKEN_FILE, "w") as f:
        f.write(_token)


def main():
    ensure_token()
    cursor = {}
    if os.path.exists(CURSOR_FILE):
        cursor = json.load(open(CURSOR_FILE))
    pending = []
    if os.path.exists(PENDING_FILE):
        pending = json.load(open(PENDING_FILE))

    code, r = call("GET", "/api/convs")
    if code != 200:
        print(json.dumps({"error": f"convs failed: {r}"}))
        sys.exit(1)

    tasks = []
    for c in r["conversations"]:
        conv_id = c["id"]
        after = cursor.get(conv_id, 0)   # 首见从 seq=0 拉取（历史按任务处理，由 pending 渐进消化）
        if c["last_seq"] <= after:
            continue
        code, mr = call("GET", f"/api/convs/{conv_id}/messages?after_seq={after}&limit=50")
        if code != 200:
            continue
        msgs = mr["messages"]
        if msgs:
            cursor[conv_id] = msgs[-1]["seq"]
        for m in msgs:
            if m["sender"] == ME or m["type"] != "text":
                continue
            if m["sender"] in SKIP_SENDERS:
                continue
            mentioned = ME in (m.get("mentions") or []) \
                or "all" in (m.get("mentions") or [])
            if not (conv_id.startswith("private:") or mentioned):
                continue
            tasks.append({
                "conv_id": conv_id, "msg_id": m["id"], "seq": m["seq"],
                "sender": m["sender"], "content": m["content"],
            })

    # 合并上次未回复的任务（重复而非丢失；按 msg_id 去重、seq 排序）
    merged = {t["msg_id"]: t for t in pending}
    for t in tasks:
        merged[t["msg_id"]] = t
    all_tasks = sorted(merged.values(), key=lambda t: t["seq"])[:50]  # pending 上限 50 防膨胀
    final = all_tasks[:MAX_PER_RUN]                                    # 单次输出条数

    with open(CURSOR_FILE, "w") as f:
        json.dump(cursor, f, ensure_ascii=False)
    with open(PENDING_FILE, "w") as f:
        json.dump(all_tasks, f, ensure_ascii=False)
    print(json.dumps(final, ensure_ascii=False))


if __name__ == "__main__":
    main()
