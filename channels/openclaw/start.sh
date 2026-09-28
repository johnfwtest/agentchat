#!/usr/bin/env bash
# OpenClaw channel 后台启动/管理：./start.sh [start] [username] [password]
# 子命令（不与用户名混淆时可用）：
#   ./start.sh start [账号 密码]   启动（默认动作，可省略 start）
#   ./start.sh stop                停止本目录的 daemon（按 pid 文件，杀不到时按路径匹配兜底）
#   ./start.sh restart [账号 密码] 重启
#   ./start.sh status              查看运行状态与日志尾部
# 用 systemd 常驻时请用 systemctl stop/start/status 管理同名服务（agentchat-channel-*
# 命名规范见 README），不要与本脚本混用（本脚本不知道 systemd 的实例）。
# 账号密码可以不给：省略时 daemon.py 依次读 环境变量 AGENTCHAT_USER/AGENTCHAT_PASSWORD →
# .env（$AGENTCHAT_ENV / 本目录 .env / ~/.agentchat/.env）→ 凭据文件
# （$AGENTCHAT_CREDS / ~/.agentchat/creds.json / 本目录 creds.json）。
# 服务器地址用 AGENTCHAT_BASE 覆盖（也可写在 .env 里）；模板见同目录 .env.example。
# 执行 OpenClaw 的工作目录用 OPENCLAW_CWD 覆盖（默认继承本进程 cwd）。
# 解释器自动挑 3.10+（daemon.py 的类型注解需要）；可用 AGENTCHAT_PYTHON 指定（也可写在 .env）。
set -e
cd "$(dirname "$0")"
HERE="$(pwd)"
PID_FILE="$HERE/daemon.pid"

case "${1:-start}" in
  stop)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      if kill "$PID" 2>/dev/null; then
        echo "stopped pid=$PID"
      else
        echo "pid=$PID 已不在运行"
      fi
      rm -f "$PID_FILE"
    elif pkill -f "$HERE/daemon.py" 2>/dev/null; then
      echo "stopped（按路径匹配兜底）"
    else
      echo "未发现运行中的 daemon"
    fi
    exit 0 ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PID_FILE")"
    else
      echo "not running"
    fi
    [ -f "$HERE/daemon.log" ] && { echo "--- daemon.log 尾部 ---"; tail -n 5 "$HERE/daemon.log"; }
    exit 0 ;;
  restart)
    "$0" stop || true
    shift
    exec "$0" "$@"
    ;;
  start) shift ;;
esac

# .env 加载：KEY=VALUE / export KEY=VALUE，支持 # 注释与引号；
# 只填充尚未设置的变量，所以真实进程环境变量始终优先于 .env。值里有 # 请用引号包住。
load_env() {
  local f k v cur
  for f in "${AGENTCHAT_ENV:-}" "$HERE/.env" "$HOME/.agentchat/.env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    while IFS='=' read -r k v || [ -n "$k" ]; do
      k="${k#"${k%%[![:space:]]*}"}"; k="${k#export }"; k="${k//[[:space:]]/}"
      case "$k" in ''|'#'*|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
      v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
      case "$v" in
        \"*\") v="${v#\"}"; v="${v%\"}" ;;
        \'*\') v="${v#\'}"; v="${v%\'}" ;;
        *'#'*) v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}" ;;
      esac
      eval "cur=\${$k-}"
      [ -n "$cur" ] && continue
      export "$k=$v"
    done < "$f"
    echo "[env] loaded $f" >&2
    return 0
  done
}
load_env

pick_python() {
  local c
  for c in "${AGENTCHAT_PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3; do
    [ -n "$c" ] || continue
    if command -v "$c" >/dev/null 2>&1 &&
       "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      echo "$c"; return 0
    fi
  done
  return 1
}
PY="$(pick_python)" || {
  echo "找不到 Python 3.10+；请用 AGENTCHAT_PYTHON 指定解释器" >&2; exit 1; }

nohup "$PY" -u daemon.py "$@" >> daemon.log 2>&1 &
echo "$!" > "$PID_FILE"
echo "started pid=$! python=$PY args='$*' base=${AGENTCHAT_BASE:-<内置默认>}, log=./daemon.log"
echo "停止：./start.sh stop ｜ 状态：./start.sh status"
