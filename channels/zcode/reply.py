#!/usr/bin/env python3
"""zcode 守护：提交对某条消息的回复（👍 回执 + 发送，幂等）。

用法：agentchat-reply.py <msg_id> <conv_id> <sender> <<'EOF'
回复正文（Markdown）……
EOF
回复正文从 stdin 读。client_msg_id = zcode-<msg_id> 保证重复提交无副作用。
配置（优先级从高到低）：环境变量 AGENTCHAT_* → .env（$AGENTCHAT_ENV → 本目录 .env →
~/.zcode/.env → ~/.agentchat/.env）→ 凭据文件 ~/.zcode/agentchat-creds.json → 兜底默认。
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
PENDING_FILE = f"{HOME}/agentchat-pending.json"


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

_token = open(TOKEN_FILE).read().strip() if os.path.exists(TOKEN_FILE) else None


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
    global _token
    code, _ = call("GET", "/api/me")
    if code == 200:
        return
    user, password = _creds()
    code, r = call("POST", "/api/auth/login",
                   {"username": user, "password": password})
    if code != 200:
        print(json.dumps({"error": f"login failed: {r}"}))
        sys.exit(1)
    _token = r["token"]
    with open(TOKEN_FILE, "w") as f:
        f.write(_token)


def main():
    if len(sys.argv) < 4:
        print("usage: agentchat-reply.py <msg_id> <conv_id> <sender>  (reply body on stdin)")
        sys.exit(2)
    msg_id, conv_id, sender = sys.argv[1], sys.argv[2], sys.argv[3]
    body = sys.stdin.read().strip()
    if not body:
        print(json.dumps({"error": "empty reply"}))
        sys.exit(2)

    ensure_token()
    # 👍 已接手回执（fire-and-forget，重复添加幂等；失败仅告警不影响回复）
    code, rr = call("POST", f"/api/messages/{msg_id}/reactions", {"emoji": "👍"})
    if code not in (200, 201):
        print(json.dumps({"warn": f"reaction failed: {code} {rr}"}))

    content = f"{body}\n\n@{sender}"
    code, r = call("POST", f"/api/convs/{conv_id}/messages",
                   {"content": content, "client_msg_id": f"zcode-{msg_id}"})
    if code not in (200, 201):
        print(json.dumps({"error": f"send failed: {code} {r}"}))
        sys.exit(1)

    # 回复成功后从未处理清单移除（失败则保留，下次 poll 重试）
    if os.path.exists(PENDING_FILE):
        pending = json.load(open(PENDING_FILE))
        pending = [t for t in pending if t["msg_id"] != msg_id]
        with open(PENDING_FILE, "w") as f:
            json.dump(pending, f, ensure_ascii=False)

    print(json.dumps({"ok": True, "seq": r.get("seq"), "idempotent": code == 200}))


if __name__ == "__main__":
    main()
