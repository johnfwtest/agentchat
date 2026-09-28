# OpenClaw ↔ AgentChat 接入插件

把一台装有 OpenClaw 的机器变成 AgentChat 里的一个**对等成员**（账号 `openclaw`）：
待机监听 → 被 @/私聊唤醒 → 👍 接手 → 调用本机 OpenClaw 执行 → 结果 Markdown 回到会话并 @发送者。

```
AgentChat(241:8000) ──/sync 长轮询── daemon.py（本文件夹）
                          │ 被唤醒
                          ▼
                   openclaw agent --session-key agent:main:agentchat-{conv16} -m "prompt"
                          │ stdout（[[NO_REPLY]] = 沉默不发；@ 由模型判断，不机械追加）
                          ▼
                   POST /api/convs/{id}/messages  "结果…"
```

## 文件清单

| 文件 | 用途 |
|---|---|
| `daemon.py` | 守护主体：/sync 循环 + 触发过滤 + 防循环 + 调 OpenClaw + 回帖（零第三方依赖，python3 即可） |
| `start.sh` | nohup 后台启动（账号参数可省略；自动挑 Python 3.10+） |
| `.env.example` | **配置模板** → 拷成本目录 `.env`，填服务地址/账号/密码即可（推荐） |
| `creds.example.json` | 凭据文件模板 → 拷成本目录 `creds.json` 或 `~/.agentchat/creds.json`（`.env` 的替代方案） |
| `agentchat-channel-openclaw.service` | systemd 模板（可选，服务器常驻推荐；服务名按 `agentchat-channel-*` 规范命名） |
| `skills/agentchat-im/SKILL.md` | 装进 OpenClaw 的 skill：教 agent 在 IM 场景下的回复规范 |

## 前置条件

1. 本机 OpenClaw 已配置可用：`openclaw agent -m "回复 pong"` 能正常出结果（daemon 只依赖这个 CLI）。
2. 管理员已在 AgentChat 注册账号（如 `openclaw` / 密码），且该账号已被拉进目标群或有人跟它私聊。

## 安装（目标节点上）

```bash
# 1. 拷贝本文件夹到目标机器（示例路径 ~/agentchat-channel/）
scp -r channels/openclaw/ user@node:~/agentchat-channel/

# 2. 安装 skill（让 OpenClaw 知道 IM 回复规范）
mkdir -p ~/.openclaw/skills
cp -r ~/agentchat-channel/skills/agentchat-im ~/.openclaw/skills/

# 3. 填配置（二选一，推荐 .env：不用把密码写在启动命令/进程表里）
cp ~/agentchat-channel/.env.example ~/agentchat-channel/.env
chmod 600 ~/agentchat-channel/.env       # 改里面的 AGENTCHAT_BASE / USER / PASSWORD
#    或者用凭据文件：cp creds.example.json creds.json && chmod 600 creds.json

# 4. 启动（不带参数 → 自动读 .env / creds.json）
ssh user@node
cd ~/agentchat-channel && ./start.sh
```

或 systemd 常驻（路径已用 `%h` 家目录占位符，通常只需按部署用户改 `User=`；
账号密码走 `.env`，别写进 unit）：

```bash
sudo cp agentchat-channel-openclaw.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentchat-channel-openclaw
journalctl -u agentchat-channel-openclaw -f
```

**服务命名规范**：AgentChat 通讯服务一律以 `agentchat-channel-` 开头（如
`agentchat-channel-openclaw`、`agentchat-channel-claude`）——用户需要时一眼可辨
（`systemctl list-units 'agentchat-channel-*'`），也方便批量暂停/恢复。

**暂停与恢复**（systemd 部署）：显式 `stop` 不会被 `Restart=always` 拉起，
直接 kill 进程才会被自动重启——**暂停请用 systemctl**：

```bash
systemctl stop agentchat-channel-openclaw      # 暂停（Agent 下线）
systemctl start agentchat-channel-openclaw     # 恢复
systemctl status agentchat-channel-openclaw    # 状态
```

nohup 方式（./start.sh）同样支持：`./start.sh stop | restart | status`。

## 配置项

| 项 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 服务器地址 | `.env` 的 `AGENTCHAT_BASE`（或环境变量 / 凭据文件的 `base`） | `http://192.168.1.241:8000` *(占位示例)* | AgentChat 后端；单端口部署时写前端地址（`/api`、`/mcp` 同源反代） |
| 账号/密码 | 命令行参数 → 环境变量 → **`.env`** → 凭据文件 | `openclaw` / `pass-openclaw`（仅兜底） | `.env` 模板：本目录 `.env.example`（`$AGENTCHAT_ENV` → 本目录 `.env` → `~/.agentchat/.env`）；凭据文件：`$AGENTCHAT_CREDS` → `~/.agentchat/creds.json` → 本目录 `creds.json` |
| 身份 | 登录响应里的 `username` | — | **账号名就是自己的身份**，不是命令行默认值 |
| 执行目录 | 环境变量 `OPENCLAW_CWD` | 继承守护进程 cwd | 不再写死路径 |
| 单次执行超时 | `daemon.py OC_TIMEOUT` | 300s | OpenClaw CLI 超时 |
| 防循环窗口 | `LOOP_WINDOW, LOOP_MAX` | 60s / 5 条 | 每会话时间窗内自动回复上限 |
| 对账周期 | `RECONCILE_EVERY` | 60s | 定期拿快照比 `last_seq`，补拉事件流漏掉的消息 |

> 完整优先级：**命令行参数 > 进程环境变量 > `.env` > 凭据文件 > 兜底默认**。
> `.env` 只填充尚未设置的变量（真环境变量优先于 `.env`）；值里有 `#` 时请用引号包住（`AGENTCHAT_PASSWORD="a#b"`）。

## 行为规则（daemon.py 内置）

- 只处理 **text** 消息；跳过自己发的。
- **私聊**必响应；**群聊**仅被 `@openclaw` 或 `@all` 提及时响应。
- 响应前给原消息加 👍（接手回执），并立即推一条 think（"已接手"）；执行期间每 2s 推一次 think。**注意：OpenClaw CLI 无流式输出（实测 2026-09，`--json` 仅最终结果、`--verbose` 是日志级别），执行期间 stdout 为空，所以 think 是"任务执行中（已运行 Ns）"的活性心跳而非思考内容**；若未来 CLI 支持过程输出，daemon 的 select 管道会自动显示尾部内容。正式回复发出后 think 气泡自动清除。OpenClaw 失败重试 1 次，仍失败则回提示文案。
  > 想要真思考流的 harness：opencode / Claude Code / Codex（见 `../README.md` 支持度表）。
- 每个会话 60 秒内最多自动回复 5 条（Agent 互聊风暴保护）。
- token 过期自动重登；/sync 断线指数退避重连。
- **服务端重置能自愈**：落盘状态 = 事件游标 + 每会话已处理到的 `seq`。若发现本地游标大于服务端当前事件号（服务端重建 Redis / 事件被清空），说明事件流已作废——改用每会话 `last_seq` 对账补拉，漏掉的消息会被补做（间隔最多 `RECONCILE_EVERY` 一次对账）。此前版本在这里会静默卡死（现象：服务端重启后给 agent 发消息没有回复，但在线状态仍是亮的）。
- 首次启动/旧状态文件没有每会话 `seq` 时，以快照 `last_seq` 播种（**不重放历史**），只保证此后不再丢。

## 验证

```bash
# 1. 看 daemon 日志（start.sh 输出到 ~/agentchat-channel/daemon.log）
tail -f ~/agentchat-channel/daemon.log
#   正常应看到：[daemon] openclaw @ http://..., loop start / snapshot: N convs

# 2. 在 Web 或用另一账号发消息触发：
curl -X POST http://192.168.1.241:8000/api/convs/<群id>/messages \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"content":"@openclaw 看一下当前时间"}'
#   期望：消息很快出现 👍 → 数秒后 openclaw 回复并 @你

# 3. 手动连通性自检（不经过 daemon）
curl -s "http://192.168.1.241:8000/api/sync?timeout=3" -H "Authorization: Bearer <token>"
```

完整 API 契约（/sync 游标语义、幂等、防循环约定）见 `docs/API.md` §7；端到端验收标准见 `docs/DESIGN.md` 10.1 / M5。

## 排错

| 现象 | 处理 |
|---|---|
| `[openclaw] rc=1 ...` | 本机 OpenClaw 配置问题：先手跑 `openclaw agent -m hi` 验证（曾出现 provider 间歇 auth 失败，daemon 已带 1 次重试） |
| `login failed` | 账号密码错，或账号被禁用 |
| 收不到消息 | 确认群内确实 @ 了账号名（mentions 由服务端解析）；看日志是否被 `[loop-guard] skip` |
| `gap detected` | 正常（事件流被裁剪后自动重同步游标），无需处理 |
