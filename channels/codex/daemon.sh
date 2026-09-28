#!/usr/bin/env bash
# Codex CLI ↔ AgentChat headless 守护（接入说明见同目录 README.md）
# 用法：./daemon.sh [username] [password]   # 参数可省略，见下
# 账号解析顺序：命令行参数 → 环境变量 AGENTCHAT_USER/AGENTCHAT_PASSWORD →
#              .env（$AGENTCHAT_ENV → 本目录 .env → ~/.agentchat/.env）→ 兜底默认
# 依赖：curl jq codex；codex CLI 已登录
# 与 channels/claude-code/daemon.sh 同构，仅执行器不同（codex exec --full-auto -）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

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

# 占位示例（历史部署用过的地址）；实际部署用 .env 或真环境变量覆盖 AGENTCHAT_BASE
BASE="${AGENTCHAT_BASE:-http://192.168.1.241:8000}"
ME="${1:-${AGENTCHAT_USER:-codex}}"
PASS="${2:-${AGENTCHAT_PASSWORD:-pass-codex}}"
CODEX_TIMEOUT=300          # 单次 codex exec 超时
LOOP_WINDOW=60 LOOP_MAX=5  # 防循环：每会话 60s 内自动回复上限

TOKEN=""
api() { # api METHOD PATH [JSON_BODY] -> body
  curl -sS -m 60 -X "$1" "$BASE$2" \
       ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
       ${3:+-H "Content-Type: application/json" -d "$3"} \
       -w '\n%{http_code}'
}
login() {
  local out
  out=$(curl -sS -m 15 -X POST "$BASE/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ME\",\"password\":\"$PASS\"}")
  TOKEN=$(echo "$out" | jq -r .token) || TOKEN=""
  [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "[login] failed: $out"; return 1; }
  # 身份以服务端返回的账号名为准（不是命令行默认值）
  local u; u=$(echo "$out" | jq -r .username)
  [ -n "$u" ] && [ "$u" != "null" ] && ME="$u"
  return 0
}

reply_count=0 reply_mark=0
loop_limited() {
  local now=$(date +%s)
  if [ $((now - reply_mark)) -gt "$LOOP_WINDOW" ]; then reply_count=0; reply_mark=$now; fi
  [ "$reply_count" -ge "$LOOP_MAX" ] && return 0
  reply_count=$((reply_count + 1))
  return 1
}

handle() { # conv_id msg_id sender content
  local conv="$1" mid="$2" sender="$3" content="$4"
  [ -n "$mid" ] && api POST "/api/messages/$mid/reactions" '{"emoji":"👍"}' >/dev/null
  loop_limited && { echo "[loop-guard] skip $conv"; return; }
  # @ 与是否回复由模型判断：机械追加 @sender 是 agent 互聊死循环的永动机
  local prompt="你是内部 IM 系统里的智能助手 $ME，有人给你发来了消息。请像同事一样处理，直接输出回复正文（Markdown，会原样发回 IM 会话，不要寒暄）。

发言规则：
- 你只能通过「输出回复正文」这一种方式说话——不要调用任何消息/发送/通道类工具。
- 判断这条消息不需要回答时，可以不回复——只输出一行 [[NO_REPLY]]；至少不要 @ 提问者，除非确实需要对方继续做什么（对方也可能是自动 agent，@ 它可能触发无休止的互答循环）。

来自 @$sender 的消息：
$content"
  local out rc
  out=$(printf '%s' "$prompt" | timeout "$CODEX_TIMEOUT" codex exec --full-auto - 2>/dev/null); rc=$?
  [ $rc -ne 0 ] && out="（codex 执行失败或超时，请稍后再试）"
  # LLM 主动沉默（[[NO_REPLY]] 或空输出——rc=0 时空输出是模型选择沉默，不是失败）：不发消息
  local trimmed; trimmed=$(echo "$out" | sed '/^[[:space:]]*$/d')
  if [ -z "$trimmed" ] || [ "$trimmed" = "[[NO_REPLY]]" ]; then
    echo "[done] NO_REPLY by LLM in $conv（不发送）"
    return
  fi
  # 幂等键绑定原消息 id：双 daemon 实例回复同一条触发消息时服务端只落地一条
  local cmid="${ME}-${mid:-$(date +%s%N)}"
  local body=$(jq -n --arg c "$out" --arg k "$cmid" '{content:$c, client_msg_id:$k}')
  local r=$(api POST "/api/convs/$conv/messages" "$body")
  local code=$(echo "$r" | tail -1)
  echo "$r" | head -n -1 | jq -e .id >/dev/null 2>&1 || echo "[send] $code"
  echo "[done] replied to $sender in $conv"
}

login || exit 1
# 单实例锁（防同机双 daemon 双跑）：只约束自动化 daemon——多端 web 登录
# （人排查/介入）不经过此锁。进程退出自动释放。升级残留旧实例时在此退出。
LOCKF="/tmp/agentchat-channel-$ME.lock"
exec 9>"$LOCKF"
if ! flock -n 9; then
  OLD_PID=$(cat "$LOCKF" 2>/dev/null || echo unknown)
  echo "[lock] 已有 $ME 的 channel 实例在运行（pid=$OLD_PID）。升级请先停旧实例："
  echo "       systemctl stop <agentchat-channel-*> 或 pkill -f daemon.sh，再启动本实例。"
  exit 1
fi
echo $$ >&9
echo "[daemon] $ME @ $BASE, loop start"
first=$(api GET /api/sync); [ "$(echo "$first" | tail -1)" = 200 ] || { echo "[daemon] first sync failed"; exit 1; }
CURSOR=$(echo "$first" | head -n -1 | jq -r .next_cursor)

while true; do
  r=$(api GET "/api/sync?cursor=$CURSOR&timeout=25")
  code=$(echo "$r" | tail -1); body=$(echo "$r" | head -n -1)
  case "$code" in
    200) ;;
    401) login; continue ;;
    *)   echo "[daemon] HTTP $code"; sleep 5; continue ;;
  esac
  CURSOR_NEW=$(echo "$body" | jq -r .next_cursor)
  # 服务端事件计数器回退（Redis 被清空 / 服务端重置）：旧游标永远等不到事件，
  # 表现为「服务端重启后给 agent 发消息没有回复」。此时重新拿快照，从当前游标接着跑。
  if [ "$CURSOR_NEW" -lt "$CURSOR" ]; then
    echo "[daemon] 事件游标回退 $CURSOR > $CURSOR_NEW（服务端重置），重新取快照"
    first=$(api GET /api/sync); [ "$(echo "$first" | tail -1)" = 200 ] || { sleep 5; continue; }
    CURSOR=$(echo "$first" | head -n -1 | jq -r .next_cursor)
    continue
  fi
  CURSOR="$CURSOR_NEW"
  echo "$body" | jq -c '.events[]? | select(.type=="message") | .message' 2>/dev/null |
  while IFS= read -r m; do
    sender=$(echo "$m" | jq -r .sender)
    conv=$(echo "$m" | jq -r .conv_id)
    type=$(echo "$m" | jq -r .type)
    [ "$sender" = "$ME" ] && continue
    [ "$type" != "text" ] && continue
    mentions=$(echo "$m" | jq -c .mentions)
    case "$conv" in private:*) trig=1 ;; *) echo "$mentions" | grep -q "\"$ME\"\|\"all\"" && trig=1 || trig=0 ;; esac
    [ "$trig" = 1 ] || continue
    handle "$conv" "$(echo "$m" | jq -r .id)" "$sender" "$(echo "$m" | jq -r .content)"
  done
done
