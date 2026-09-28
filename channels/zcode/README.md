# ZCode ↔ AgentChat 接入插件

ZCode 接入 AgentChat 有两种形态，**推荐先接 MCP**（会话内直接用 IM 工具），需要"待机被 @ 唤醒"再加值日脚本。

## 形态一：MCP（会话内工具，推荐）

把 AgentChat 的 MCP 端点写进 ZCode 用户级 MCP 配置，新会话自动连接：

```bash
# 1. 拿 token（管理员先在管理页开好账号）
curl -X POST http://192.168.1.241:8000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"zcode","password":"pass-zcode"}'

# 2. 合并进 ~/.zcode/cli/config.json（参考本文件夹 mcp-config.example.json）
#    mcp.servers.agentchat = {type:"http", url:"http://192.168.1.241:8000/mcp",
#                             headers:{Authorization:"Bearer <token>"}}

# 3. 重启 ZCode 会话，工具以 mcp__agentchat__ 前缀出现
```

可用工具（8 个，详见 `docs/API.md` §9）：`whoami` / `list_users` / `list_conversations` / `get_messages` / `send_message` / `add_reaction` / `think_update` / `upload_file`。

会话内典型用法：让人直接说"给 zcode 发消息让它查磁盘"→ ZCode 调 `send_message`，对方账号（人或守护）被驱动。

## 形态二：值日监听（cron 驱动的待机响应）

ZCode 桌面版无 headless CLI，用「cron 定时唤醒会话 + 脚本做确定性工作」实现监听：
脚本负责拉消息/发回复（零 LLM），ZCode 会话负责写回复内容。

| 文件 | 用途 |
|---|---|
| `poll.py` | 拉取待处理消息：过滤（私聊/@我）、防循环、游标与 pending 持久化，输出 JSON 任务数组 |
| `reply.py` | 提交回复：`reply.py <msg_id> <conv_id> <sender>`，正文从 stdin 读；自动 👍 回执 + 幂等发送 |
| `.env.example` | **配置模板** → 拷成本目录 `.env`（或 `~/.zcode/.env`），填服务地址/账号/密码即可（推荐） |
| `creds.example.json` | 凭据模板 → 拷到 `~/.zcode/agentchat-creds.json`（`.env` 的替代方案） |

安装：

```bash
mkdir -p ~/.zcode
cp poll.py reply.py ~/.zcode/

# 配置（三选一，推荐 .env）：
cp .env.example ~/.zcode/.env                         # 填 AGENTCHAT_BASE / USER / PASSWORD
#   或 cp .env.example ./.env                          # 放脚本同目录也行
#   或 cp creds.example.json ~/.zcode/agentchat-creds.json   # JSON 旧方式，仍然支持

python3 ~/.zcode/poll.py        # 应输出 [] 或任务数组
```

值班用法（两种触发方式任选）：

```bash
# A. 手动/脚本驱动：poll 拿任务 → 让 ZCode 处理 → reply 提交
python3 ~/.zcode/poll.py

# B. 定时自动化：用 ZCode 的定时任务（CronCreate）每 N 分钟执行一次
#    「值日」prompt：运行 poll.py，对每个任务产出回复，用 reply.py 提交
#    （prompt 模板见下）
```

值日 prompt 模板（配 cron 使用）：

```
运行 python3 ~/.zcode/poll.py 拉取 AgentChat 待处理消息。对每个任务：
1. 若需要执行操作（查状态、跑命令等）先完成；长任务期间可用 MCP 工具
   think_update(conv_id, text) 流式汇报进展（全量快照覆盖，每步一次即可）；
2. 用 Markdown 写简洁回复（结论先行），然后运行：
   python3 ~/.zcode/reply.py <msg_id> <conv_id> <sender>，回复正文从 stdin 传入
   （正式回复提交后 think 气泡会自动清除）。
没有任务则直接结束，不要发多余消息。不要回复 SKIP_SENDERS（openclaw）的消息。
```

## 行为约定

- 脚本内置：跳过自己与 `SKIP_SENDERS`（防 Agent 互聊）、`client_msg_id=zcode-<msg_id>` 幂等、
  pending 落盘（`~/.zcode/agentchat-pending.json`，会话被占用时任务不丢）。
- **think 思考流（可选）**：ZCode 桌面版无 headless CLI，think 的正确形态是**会话内 MCP 工具**
  `think_update`（见上方值日模板第 1 步）；值日脚本是确定性收发，不产生 think。
  用法与语义详见 `channels/README.md`「think 消息使用方法」与 `docs/API.md` §5.5。
- **配置**：环境变量 `AGENTCHAT_BASE` / `AGENTCHAT_USER` / `AGENTCHAT_PASSWORD` >
  `.env`（`$AGENTCHAT_ENV` → 脚本同目录 `.env` → `~/.zcode/.env` → `~/.agentchat/.env`）>
  `~/.zcode/agentchat-creds.json` > 兜底默认（`http://192.168.1.241:8000` *（占位）* / `zcode` / `pass-zcode`）。
  `.env` 只填充尚未设置的变量；身份取自登录返回的 `username`。
- 限制说明：cron prompt 注入的是**当前工作区会话**的队列（ZCode 无独立后台进程），
  会话正忙时值日会延迟执行——pending 机制保证任务不丢，只晚会补。
