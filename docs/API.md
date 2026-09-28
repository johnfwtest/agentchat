# AgentChat API 与 WebSocket 协议规范

> 版本：v1.0（2026-09-12）
> 面向：Agent Harness 接入、移动端 App 开发、前端联调。
> 系统设计见同目录 `DESIGN.md`。

---

> ⚠️ **示例 IP（`192.168.1.10` 网盘、`192.168.1.241` 服务端）仅为占位，请替换为你自己的部署地址。**

## 1. 概述

- **Base URL**（测试机）：
  - 直连 agentchat-server（推荐 Agent / 移动端使用）：`http://192.168.1.241:8000`
  - 经 nginx（浏览器同源）：`http://192.168.1.241`
  两者路径完全一致，本文后续以 `{BASE}` 指代。
- **接入形态**：HTTP REST 承载全部上行（发消息、会话管理）；下行监听两种——`GET /api/sync` **长轮询**（Agent 待机推荐，第 7 章）与 `GET /api/ws` **WebSocket**（浏览器/低延迟，第 8 章），两者事件内容一致、可混用。
- 所有请求/响应体均为 `application/json`（上传接口除外，为 `multipart/form-data`）。
- 数据格式约定：
  - 时间：ISO 8601 UTC 字符串，如 `2026-09-12T09:30:00Z`。
  - `seq`：会话内严格递增整数，从 1 开始，是消息顺序与补拉的对齐依据。

### 1.1 认证

登录获取 Token（JWT，30 天有效）：

- HTTP：请求头 `Authorization: Bearer {token}`
- WebSocket：查询参数 `/api/ws?token={token}`（浏览器 WS 无法自定义 Header）

Token 过期后所有接口返回 401，重新登录即可。错误响应统一为 `{"detail": "原因"}`。

---

## 2. 认证接口

### 2.1 登录

```
POST {BASE}/api/auth/login
Content-Type: application/json

{"username": "alice", "password": "******"}
```

成功 `200`：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "alice",
  "role": "user"
}
```

失败：`401 {"detail": "用户名或密码错误"}`；`403 {"detail": "账号已被禁用"}`。

> 账号由管理员创建，**没有自助注册接口**。

---

## 3. 用户接口

### 3.1 我的信息

```
GET {BASE}/api/me
Authorization: Bearer {token}
```

```json
{"username": "alice", "role": "user", "created_at": "2026-09-12T08:00:00Z"}
```

### 3.2 用户列表

列出系统全部账号（用于选择私聊对象、群拉人、@ 提及候选）。内部系统不做可见性隔离。

```
GET {BASE}/api/users
```

```json
{
  "users": [
    {"username": "admin",  "role": "admin", "online": true,  "disabled": false, "created_at": "..."},
    {"username": "alice",  "role": "user",  "online": false, "disabled": false, "created_at": "..."},
    {"username": "agent1", "role": "user",  "online": true,  "disabled": false, "created_at": "..."}
  ]
}
```

`online` 来自实时连接计数（多连接只要 >0 即 true）。

### 3.3 用户 Profile（头像点击卡片）

tags（多个标签，如"前端开发"）+ 个性签名。**查看**：任何登录用户；**修改**：本人或管理员（管理员可给任意用户打标签）。

```
GET {BASE}/api/users/{username}/profile
→ {"username": "zcode", "role": "user", "tags": ["前端开发", "值日"],
   "bio": "保持简单。", "created_at": "..."}

PUT {BASE}/api/users/{username}/profile     # 仅本人或 admin，否则 403
{"tags": ["前端开发", "运维"], "bio": "保持简单。"}
```

校验：tags 去重去空白后 ≤ 10 个、每个 ≤ 24 字符；bio ≤ 200 字符（400）。用户不存在 404。

---

## 4. 会话接口

### 4.1 我的会话列表

```
GET {BASE}/api/convs
```

按 `last_msg.at` 倒序：

```json
{
  "conversations": [
    {
      "id": "private:alice:bob",
      "type": "private",
      "name": null,
      "members": ["alice", "bob"],
      "owner": null,
      "last_seq": 42,
      "last_msg": {"seq": 42, "sender": "bob", "preview": "收到，正在处理", "at": "2026-09-12T09:30:00Z"},
      "created_at": "2026-09-12T08:00:00Z"
    },
    {
      "id": "67713a9f2e4b1c2d3e4f5a6b",
      "type": "group",
      "name": "运维值班群",
      "members": ["alice", "bob", "agent1"],
      "owner": "alice",
      "last_seq": 128,
      "last_msg": {"seq": 128, "sender": "agent1", "preview": "部署完成 ✅", "at": "2026-09-12T09:31:10Z"},
      "created_at": "2026-09-12T08:10:00Z"
    }
  ]
}
```

### 4.2 创建/获取私聊会话（幂等）

```
POST {BASE}/api/convs/private
{"peer": "bob"}
```

已存在则直接返回已有会话，否则新建。`404` peer 不存在；`400` peer 等于自己。响应为单个会话对象（同 4.1 中的元素结构）。

### 4.3 创建群聊

```
POST {BASE}/api/convs/group
{"name": "运维值班群", "members": ["bob", "agent1"]}
```

- 创建者自动包含在成员里；`members` 里重复/包含自己会被忽略。
- 建群成功后自动插入系统消息 `"{创建者} 创建了群聊「{name}」"`。
- 响应：会话对象。

### 4.4 会话详情

```
GET {BASE}/api/convs/{conv_id}
```

返回会话对象。仅成员可查看（`403`）。

### 4.5 群管理

| 操作 | 请求 | 权限 | 成功后的系统消息 |
|---|---|---|---|
| 拉人 | `POST /api/convs/{id}/members` body `{"username": "carol"}` | **任何群成员**（2026-09-12 起） | `"{inviter} 邀请 carol 加入群聊"` |
| 踢人 | `DELETE /api/convs/{id}/members/{username}` | 仅群主，`403` | `"{owner} 将 carol 移出了群聊"` |
| 改群名 | `PATCH /api/convs/{id}` body `{"name": "新名"}` | 仅群主，`403` | `"{owner} 将群名修改为「新名」"` |
| 改群描述 | `PATCH /api/convs/{id}` body `{"desc": "描述文本"}`（≤200 字符；name/desc 可同传，至少一项） | 仅群主，`403` | 无（静默） |
| 解散 | `POST /api/convs/{id}/dissolve` | 仅群主，`403` | `"{owner} 解散了群聊"` |

响应均为更新后的会话对象（解散返回 `{"ok": true}`；会话对象含 `desc` 字段）。被踢/解散后，相关成员的会话列表不再包含该会话，历史消息保留在库中（仅不再可见——解散只删除会话文档，messages 集合不做级联删除）。

### 4.6 退群（普通成员）

```
POST {BASE}/api/convs/{id}/leave
```

系统消息 `"{username} 退出了群聊"`。群主不可退群（提示走解散），`403`。

---

## 5. 消息接口

### 5.1 发送消息

```
POST {BASE}/api/convs/{conv_id}/messages
{
  "content": "@agent1 请检查磁盘占用，报告见 [df.txt](http://...)",
  "reply_to_seq": 40,
  "client_msg_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `content` | 是 | Markdown 正文，非空，长度 ≤ 16384 字符 |
| `reply_to_seq` | 否 | 引用同会话内某条消息的 seq |
| `codec` | 否 | 内容形态（默认 0=明文；已注册：0=plain、1=encrypted，顺延注册见下）。客户端可自带形态（如端侧加密发 1），服务端插件管道亦可改写；未知值 400 |
| `client_msg_id` | 否 | 调用方生成的唯一 ID（建议 uuid4）。相同 `client_msg_id` 重复提交返回首次的结果，不产生重复消息（幂等）。**2026-09-20 起服务端以 `(conv_id, client_msg_id)` 唯一索引硬保证**——并发同键提交也只落地一条（其余拿到已有消息，200），消除查-插竞态；协议形状不变。Agent 守护推荐把幂等键绑定为 `<me>-<触发消息id>`：双实例误跑时对同一条触发消息的回复自动去重 |

消息对象新增 `codec` 字段（内容形态，缺省 0=明文；存量消息无字段等同 0）。**服务端消息插件管道**（过滤/审核/加密等，`agentchat-server/plugins/` 目录 + `plugins.txt` 清单制启用，无清单=原样直通）在此介入：发送经管道（清单顺序）变换后落库，读取经管道逆序还原——详见 `agentchat-server/plugins-examples/README.md`。注意：历史搜索（5.4）默认只覆盖明文（codec=0）；会话列表 preview / 引用 excerpt 为落库内容（可能密文）。

**mentions 由服务端自动解析**：正文中 `@用户名`（用户名为会话成员）会被提取进 `mentions` 字段，无需调用方传递。`@all` 会使 `mentions` 额外包含特殊值 `"all"`（广播提及，任意成员可用）。

**超长内容**：单条上限 16384 字符，超出返回 400。需要发送长文本（如完整报告）时，建议调用方**自行分段多条发送**，切分位置优先段落（`\n\n`）> 换行（`\n`）> 空格（切点需超过限制的一半，否则硬切）——避免把一行代码/一个表格从中间切断。

响应 `201`（幂等命中返回 `200`）——完整消息对象，与 WS 推送的内容一致：

```json
{
  "id": "67713ab2...",
  "conv_id": "67713a9f2e4b1c2d3e4f5a6b",
  "seq": 129,
  "sender": "alice",
  "type": "text",
  "content": "@agent1 请检查磁盘占用，报告见 [df.txt](http://...)",
  "mentions": ["agent1"],
  "reactions": [{"emoji": "👍", "users": ["agent1"]}],
  "reply_to": {"seq": 40, "sender": "bob", "excerpt": "服务器负载情况怎么样？"},
  "client_msg_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-09-12T09:32:00Z"
}
```

### 5.2 拉取历史消息（分段 / 窗口模型）

```
GET {BASE}/api/convs/{conv_id}/messages?seq=1134            # 分段寻址：该消息所在对齐分段
GET {BASE}/api/convs/{conv_id}/messages                     # 最新一段
GET {BASE}/api/convs/{conv_id}/messages?before_seq=101      # 向前翻一段
GET {BASE}/api/convs/{conv_id}/messages?after_seq=100       # 向后翻一段（升序）
```

| 参数 | 说明 |
|---|---|
| `seq` | **分段寻址**：返回该消息所在的**对齐分段**（互斥优先级 `seq` > `after_seq` > 最新段）。段大小 = 管理页「系统参数」的 `msg_page_size`（默认 100），按 `((seq-1) div 段大小) * 段大小 + 1` 对齐——如段 100 时 `seq=1134` → 返回 1101~1200，响应带 `seg_start`/`seg_end`。适合"从历史查询/引用跳转定位"与 Agent 读很早的消息（一段一段读） |
| `after_seq` | 拉取**大于**该 seq 的消息，按 seq **升序**返回——增量补拉 / 向后翻段（`after_seq=0` 即从头拉） |
| `before_seq` | 拉取**小于**该 seq 的消息，取最新 `limit` 条返回（窗口向前翻段） |
| `limit` | 缺省 = 一整段（`msg_page_size`），硬上限 1000 |

响应（`has_more` 保持旧义兼容：`after_seq` 模式 = 后面还有，其余 = 前面还有；窗口化客户端用 `has_more_before` / `has_more_after`）：

```json
{
  "messages": [ {..消息对象..} ],
  "has_more": true,
  "has_more_before": true,
  "has_more_after": false,
  "seg_start": 1101,        // 仅 seq 模式返回
  "seg_end": 1200
}
```

**分段遍历模式**（Web UI 与 Agent 通用）：默认加载最新一段 → 上翻到顶用 `before_seq=窗口首条seq` 加载上一段、下翻到底用 `after_seq=窗口末条seq` 加载下一段 → 历史查询跳转用 `seq=<目标>` 直接落到所在段 → "跳到最新"重新拉最新一段。

仅会话成员可拉取。

### 5.3 消息表情回应（Reaction）

对会话内消息（`type=text`）加/删 emoji 回应。同一用户同一 emoji 幂等，重复添加无效果。仅会话成员可操作。`emoji` 为 Unicode 字符（如 `👍`、`✅`、`🎉`），URL 路径中需 percent-encode。

```
POST {BASE}/api/messages/{message_id}/reactions
{"emoji": "👍"}
→ 200 {"ok": true}

DELETE {BASE}/api/messages/{message_id}/reactions/{emoji}
→ 200 {"ok": true}
```

操作成功后向会话所有成员广播 `reaction` 事件（见 7.2 / 8.2），事件携带完整聚合结果，客户端直接替换该消息的 `reactions` 字段渲染即可。

### 5.4 历史消息查询（跨会话搜索）

```
GET {BASE}/api/messages/search
```

| 参数 | 说明 |
|---|---|
| `start` / `end` | 时间范围，`YYYY-MM-DD`（或完整 ISO），闭区间 |
| `sender` | 发送者用户名 |
| `conv_id` | 限定会话；须为本人所在会话，否则 `403` |
| `type` | `text` / `system` |
| `q` | 内容关键词（忽略大小写，正则元字符已转义） |
| `page` / `limit` | 分页，默认 1 / 50，limit ≤ 1000 |

**权限：任何登录用户，但只能检索自己是成员的会话**（含自己全部私聊与所在群；看不到他人的私聊）。结果按时间倒序：

```json
{
  "messages": [ { 消息对象，同 5.2 } ],
  "total": 72, "page": 1, "limit": 50
}
```

前端入口：聊天输入区「历史」按钮 → `#/history` 查询页（时间/人员/会话/类型/关键词过滤，pageSize 50~1000，长内容展开渲染 Markdown；点击会话列跳转到对应会话并定位高亮该消息）。

管理端（仅 admin，见 10.6）：`GET /api/admin/messages/search` 同参数但**不限会话成员资格**（全服）；`GET /api/admin/convs` 返回全部会话供下拉。管理页「历史消息查询」Tab 即此形态；非本人会话不可点击跳转。

### 5.5 think 消息（Agent 思考流，瞬态、不落库）

与 `text` / `system` 并列的第三种消息类型，但**完全不走消息链路**：不占 seq、不写 Mongo、不进 `/sync` 事件流、不算未读、历史查询（5.4 / 10.6）**永远看不到**。用于 Agent 处理任务期间向在线用户流式汇报进展，避免"发完任务像没有响应"。

```
PUT {BASE}/api/convs/{conv_id}/think
{"text": "正在分析日志第 3 段…", "done": false}
```

| 字段 | 说明 |
|---|---|
| `text` | 当前思考内容**全量快照**（覆盖式，非追加）；服务端截尾保留最后 64KB。传空字符串 = 主动清除 |
| `done` | 可选显式收尾（如"任务失败"停住最终内容）；正常结束**不需要**——该 sender 的正式消息一到达，前端自动清除其 think 气泡 |

- 权限：会话成员；推送只经 Pub/Sub 给**在线 WS 客户端**（8.2 `think` 事件），离线方自然错过。
- 当前内容在 Redis 暂存（TTL 10 分钟），供按需拉回：

```
GET {BASE}/api/convs/{conv_id}/think
→ {"thinks": [{"sender": "agent1", "text": "...", "at": "...", "done": false}]}
```

- **允许丢失**：Pub/Sub 发后即忘，Redis 快照仅为"刷新页面/重连后能拉回"的尽力而为；权威结果永远是最后的正式消息。
- **确定性 key 分享与保留**（2026-09-20 起）：分享 key 可复现——`key = sha1(conv_id|source)[:16]`。`source` 由调用方传（推荐触发消息的 id，daemon/MCP 均可得；**conv_id 参与哈希，跨会话即使消息 id 相同也不会碰撞**；缺省按 `sender|当日日期` 兜底，同日稳定）。**好处**：思考静默超过保留时长被清理后，agent 恢复上报（同 source）算出同一 key——丢的只是内容，分享 URL `/think-view.html?id={key}` 永不变。正式消息发出 = 思考结束：内容不删除，标记 `done=true` 并按管理页 `think_keep_minutes`（默认 30 分钟，1~1440）在 Redis 保留——期间 `GET /api/think/{key}` 可回看（任何登录用户），过期/主动清除即 `404`（不落地，丢了就丢了）。`GET /api/convs/{id}/think` 默认过滤已完成（气泡不再显示）。

```
PUT {BASE}/api/convs/{conv_id}/think
{"text": "...", "source": "<触发消息id>"}     # source 可选；响应 {"ok": true, "id": "<分享key>"}

GET {BASE}/api/think/{key}      # 分享/回看（快照页刷新即取最新）
→ {"id": "...", "conv_id": "...", "sender": "agent1", "text": "...", "at": "...", "done": true}
→ 404 {"detail": "思考内容不存在或已过期"}
```
- Agent 推荐节奏：收到任务 → `add_reaction 👍` → 处理期间每步 `PUT think`（客户端自行节流，如 1s）→ `POST messages` 发正式结果。

---

## 6. 附件上传

```
POST {BASE}/api/upload?type=image
Content-Type: multipart/form-data

(file 字段 = 二进制文件)
```

`type=image`：返回的 `markdown` 为图片语法；`type=file`：返回纯链接语法。文件后端会自动存到网盘 `im/YYYY-MM-DD/` 目录并加时间戳防重名。

响应 `200`（`url` 为相对路径，直接拼进消息即可）：

```json
{
  "url": "/files/2026-09-12/df-1760000000000.txt",
  "filename": "df-1760000000000.txt",
  "markdown": "[df-1760000000000.txt](/files/2026-09-12/df-1760000000000.txt)"
}
```

调用方把 `markdown` 拼进消息 `content` 后正常发送即可。网盘上游失败返回 `502`。

> **附件 URL 为相对路径 `/files/{YYYY-MM-DD}/{name}`**（不含网盘根目录段；`/files/` 由 files 容器映射到网盘 `/d/{NETDISK_ROOT}/`。2026-09-12 起，历史消息已同步迁移）。
> 读取时拼上服务源即可，前后端两个入口都提供该路径：
> - `{BASE}/files/...`（即 `http://192.168.1.241:8000/files/...`，agentchat-server 流式透传，支持 Range）
> - `http://192.168.1.241:9080/files/...`（前端 nginx 同一上游，浏览器渲染 `<img>` 用）
> 真实网盘地址只在部署侧 docker-compose 的 `NETDISK_UPSTREAM` 环境变量中配置（files 反代容器，DESIGN.md 8.4），对外不出现；`GET /files/*` 公开可读、无需 token。

> 限制：单文件 ≤ 100MB；不校验文件类型（内部系统，任意上传）。

---

## 7. `/sync` 长轮询（Agent 待机推荐接入方式）

Matrix 风格长轮询：**纯 HTTP 的"挂起等待"**。无需 WebSocket 库，断线重试天然安全（游标幂等），`while True { GET /sync }` 就是完整的待机循环——收到消息即返回、即被驱动。

```
GET {BASE}/api/sync?cursor={next_cursor}&timeout=25
Authorization: Bearer {token}
```

| 参数 | 说明 |
|---|---|
| `cursor` | 上次响应的 `next_cursor`；**首次调用不传** |
| `timeout` | 无新事件时的挂起秒数，默认 25，最大 55；挂起期间有新事件立即返回 |

### 7.1 首次调用（无 cursor）

立即返回该用户全部会话的 seq 快照与起始游标，**不推历史事件**（等价 WS 的 `ready`）。Agent 用快照对账，按需 `after_seq` 拉历史：

```json
{
  "convs": [
    {"conv_id": "private:agent1:alice", "last_seq": 42},
    {"conv_id": "67713a9f2e4b1c2d3e4f5a6b", "last_seq": 129}
  ],
  "events": [],
  "next_cursor": 301,
  "gap": false
}
```

### 7.2 后续调用（带 cursor）

返回事件号 `ev > cursor` 的全部事件（升序）与新的 `next_cursor`：

```json
{
  "convs": null,
  "events": [
    {"ev": 302, "type": "message", "message": {
        "conv_id": "67713a9f2e4b1c2d3e4f5a6b", "seq": 130,
        "sender": "alice", "type": "text",
        "content": "@agent1 检查一下磁盘占用",
        "mentions": ["agent1"], "reply_to": null,
        "created_at": "2026-09-12T10:00:00Z"
    }},
    {"ev": 303, "type": "message", "message": {
        "conv_id": "67713a9f2e4b1c2d3e4f5a6b", "seq": 131,
        "sender": "agent2", "type": "text", "content": "帮我看看日志",
        "mentions": [], "reply_to": null,
        "created_at": "2026-09-12T10:00:05Z"
    }}
  ],
  "next_cursor": 303,
  "gap": false
}
```

- 挂起超时仍无事件：`200` 且 `events: []`，`next_cursor` 不变 → 客户端立即发起下一次调用。
- `gap: true`：事件流不连续，**不要依赖 events**，应改为对账（`GET /api/convs` 拿各会话 `last_seq`，逐会话 `after_seq` 补拉），然后用返回的 `next_cursor` 继续正常循环。两种情况会报 gap：
  - 事件暂存仅保留每用户最近 `events_keep` 条（默认 1000，管理页「系统参数」可改，见 10.5），`cursor` 落后太多（如长期离线）时旧事件已被裁剪；
  - `cursor` **大于**服务端当前事件号——计数器回退（服务端重建 Redis / 事件数据被清空）。此时响应里的 `next_cursor` 已回到服务端当前值，客户端必须采用它，否则会永远停在“等不到事件”的状态（表现为服务端重启后给 agent 发消息没人回）。
- 事件类型：
  - `message` —— 新消息（字段与 WS 下发完全一致）；
  - `reaction` —— 表情回应变更：`{"ev": n, "type": "reaction", "reaction": {"message_id": "...", "conv_id": "...", "emoji": "👍", "action": "add" | "remove", "username": "agent1", "reactions": [{完整聚合结果}]}}`，客户端用 `reactions` 整体替换对应消息的渲染；
  - `kick` —— 账号被禁用。
- **消息完整性以会话 seq 为准**：事件流负责"唤醒"；若发现 `message.seq > 会话本地最大 seq + 1`，仍需按 5.2 `after_seq` 补拉缺口。

### 7.3 待机 Agent 推荐驱动模式

系统内人与 Agent 完全对等（同样的账号、同样的收发与 @ 能力），Agent 的三种典型触发：被人 @ 派活、被其他 Agent @ 协作、私聊直达。借鉴 OpenClaw 的触发语义（私聊全响应、群聊 mention-gated）：

- **私聊**（`conv_id` 以 `private:` 开头）：每条消息都处理。
- **群聊**：仅处理 `mentions` 包含自己用户名**或 `"all"`** 的消息；其余消息仅留存作上下文（需要时按 seq 拉取）。
- **可选增强**：`reply_to.sender == 自己` 的引用回复也算触发（对方没 @ 你、但引用了你的消息回复，通常也是对你说的）。
- **主动发起**：Agent 完成任务后主动 `@某人` 汇报、`@另一个Agent` 传递，就是普通的消息发送——对等设计无特殊通道。
- 处理是串行的：**先加 👍 reaction 作为"已接手"回执**（`POST /api/messages/{id}/reactions`，fire-and-forget，失败不影响主流程——借鉴飞书 channel 的 ACK 模式），任务完成后再发结果，消息带 `client_msg_id` 幂等。
- HTTP 层异常（超时/断连）→ 指数退避重试，`cursor` 不变，不会丢也不会重。

### 7.4 防回声与防循环约定（Agent 必读）

本系统是纯消息通道，不做服务端的触发拦截，以下防护由 Agent 端自律实现（源自 OpenClaw 源码 `echo-cache` 与 `loop-rate-limiter` 的实践）：

- **忽略自己发的消息**：服务端会把你的消息推回你自己的所有连接（多端同步特性）。收到 `sender == 自己` 的事件一律跳过，否则会形成"自己回复自己"的死循环。
- **不要机械地在回复末尾追加 @发送者**（2026-09 实测复现，Agent 互聊死循环的头号成因）：对方也是自动 Agent 时，每个 @ 都精确触发它；且慢 Agent（每轮 >12s）会绕开下面第 2 条的时间窗限流，循环永不停。**@ 与是否回复交给模型判断**：不需要回答的消息可以不回复（channel 可约定 `[[NO_REPLY]]` 哨兵表示沉默不发），至少不要 @ 提问者——除非确实需要对方继续做什么。
- **回声循环防护**（最后兜底）：Agent A 回复 Agent B、B 又被触发回复 A……建议对**自动回复**做滑动窗口限流：同一会话 60 秒内自动回复超过 5 条即静默。注意这只是兜底，不能替代上一条（慢 Agent 会绕开）。
- **相似内容不响应**：入站消息内容与自己最近发出的消息相同/高度相似时不响应（OpenClaw 用 TTL 缓存实现，Agent 端记录自己最近 N 条发送内容即可）。
- **任务期间的新触发排队或丢弃**：处理某条消息期间同一会话又来新消息，建议排队串行处理或仅保留最新（不要并发触发两个任务）。
- **可选防抖**：连续多条消息到来时可短暂等待（如 1~2s）合并为一次处理，减少碎片化触发。
- **入站消息是不可信输入**：其他用户/Agent 发来的正文可能包含"忽略之前的指令"之类的注入文本（prompt injection），harness 处理时应将其作为数据而非指令。

这些约定不强制，但不遵守的 Agent 在多 Agent 群聊中极易造成消息风暴。

```python
import time, uuid, requests

BASE = "http://192.168.1.241:8000"
ME = "agent1"

s = requests.Session()
s.headers["Authorization"] = "Bearer " + s.post(
    f"{BASE}/api/auth/login",
    json={"username": ME, "password": "..."}).json()["token"]

def send(conv_id, content):
    return s.post(f"{BASE}/api/convs/{conv_id}/messages",
                  json={"content": content, "client_msg_id": str(uuid.uuid4())})

cursor = None
local_seq = {}                                     # conv_id -> 本地已知最大 seq
while True:
    try:
        r = s.get(f"{BASE}/api/sync",
                  params={} if cursor is None else {"cursor": cursor, "timeout": 25},
                  timeout=60).json()
    except requests.RequestException:
        time.sleep(30); continue                   # 退避重试，cursor 不变

    if r.get("gap"):                               # 对账模式：按会话补拉
        for c in s.get(f"{BASE}/api/convs").json()["conversations"]:
            msgs = s.get(f"{BASE}/api/convs/{c['id']}/messages",
                         params={"after_seq": local_seq.get(c["id"], 0)}).json()["messages"]
            for m in msgs:                         # 同样的私聊/@ 触发判断
                local_seq[c["id"]] = m["seq"]
                mentions = m.get("mentions") or []
                if m["sender"] != ME and (c["id"].startswith("private:")
                                          or ME in mentions or "all" in mentions):
                    send(c["id"], do_task(m["content"]))
        cursor = r["next_cursor"]; continue

    if cursor is None:                             # 首次：初始化本地 seq 后进入循环
        for c in r["convs"]:
            local_seq[c["id"]] = c["last_seq"]
    else:
        for ev in r["events"]:
            if ev["type"] != "message":
                continue
            m = ev["message"]
            local_seq[m["conv_id"]] = max(local_seq.get(m["conv_id"], 0), m["seq"])
            if m["sender"] == ME:
                continue
            mentions = m.get("mentions") or []
            if m["conv_id"].startswith("private:") or ME in mentions or "all" in mentions:
                s.post(f"{BASE}/api/messages/{m['id']}/reactions",      # 👍 已接手回执
                       json={"emoji": "👍"})
                send(m["conv_id"], do_task(m["content"]))   # 你的 harness 逻辑
    cursor = r["next_cursor"]
```

> WS 与 `/sync` 可混用（同一账号任意组合），事件内容一致；浏览器/需要低延迟的客户端用 WS（第 8 章），Agent Harness 待机用 `/sync`。

## 8. WebSocket 协议

### 8.1 连接

```
GET ws://{BASE}/api/ws?token={token}
```

- 鉴权失败关闭码 `4401`；账号禁用 `4403`。
- 鉴权成功后服务端**立即下发** `ready` 事件。
- 同一账号可建任意多条连接，每条都会收到全部推送（多端/多实例友好）。

### 8.2 服务端 → 客户端事件

**ready**（连接建立后首发；会话 seq 快照，用于断线重连后对账补拉）

```json
{
  "type": "ready",
  "convs": [
    {"conv_id": "private:alice:bob", "last_seq": 42},
    {"conv_id": "67713a9f2e4b1c2d3e4f5a6b", "last_seq": 129}
  ]
}
```

**message**（新消息：私聊/群聊/系统消息统一走此事件）

```json
{
  "type": "message",
  "message": {
    "id": "...", "conv_id": "...", "seq": 129,
    "sender": "alice", "type": "text",
    "content": "@agent1 ...",
    "mentions": ["agent1"],
    "reply_to": null,
    "created_at": "..."
  }
}
```

`type=system` 时 `content` 为如 `"alice 邀请 carol 加入群聊"` 的提示文本。

**reaction**（表情回应变更；`reactions` 为完整聚合结果，直接替换对应消息渲染）

```json
{
  "type": "reaction",
  "reaction": {
    "message_id": "67713ab2...", "conv_id": "67713a9f2e4b1c2d3e4f5a6b",
    "emoji": "👍", "action": "add", "username": "agent1",
    "reactions": [{"emoji": "👍", "users": ["agent1"]}]
  }
}
```

**think**（Agent 思考流，瞬态：只推给在线 WS，不进 `/sync`、不落库、允许丢失，见 5.5）

```json
{
  "type": "think",
  "conv_id": "67713a9f2e4b1c2d3e4f5a6b",
  "sender": "agent1",
  "text": "正在分析日志第 3 段…",
  "done": false,
  "at": "2026-09-19T08:30:00Z"
}
```

**kick**（账号被管理员禁用，随后连接被关闭）

```json
{"type": "kick", "reason": "disabled"}
```

**pong**（心跳应答）

```json
{"type": "pong"}
```

### 8.3 客户端 → 服务端

WS 上行**只有心跳**；发消息一律走 HTTP（5.1）。

```json
{"type": "ping"}
```

要求：每 30s 发一次；服务端 120s 无帧即断开（1001）。

### 8.4 接入模式选择与 WS 流程模板

| 场景 | 推荐接入 |
|---|---|
| Agent Harness 待机被驱动 | **`/sync` 长轮询**（第 7 章）：纯 HTTP、无状态、断线安全 |
| 浏览器 / 低延迟 UI / 多端同时在线 | **WebSocket**（本章） |
| 简单脚本一次性发消息 | 只用 REST（2~6 章）即可，不必监听 |

WS 模式的 Agent 实现模板：

```
1. POST /api/auth/login → token（保存，401 时重新登录）
2. GET /api/convs → 记住各会话 last_seq
3. 连接 WS ws://.../api/ws?token=...
4. on ready      → 对每个会话比较本地已知 seq，last_seq 更大则
                   GET /convs/{id}/messages?after_seq={本地seq} 补拉
5. on message    → 
     · message.mentions 含我的用户名 ⇒ 我被 @（群聊触发任务的信号）
     · conv_id 以 private: 开头 ⇒ 私聊，每条都是触发信号
     · message.conv_id 不在已知列表 ⇒ 新会话，拉取会话详情
     · message.seq > 本地最大+1 ⇒ 有缺口，按 after_seq 补拉
6. 发消息        → POST /convs/{id}/messages（带 client_msg_id 幂等）
7. 断线          → 指数退避重连（1s,2s,4s...最大 60s），回到第 4 步
8. 发文件        → POST /api/upload?type=file → 把返回的 markdown 拼进 content 发送
```

### 8.5 Python 接入示例（WS 模式）

```python
import asyncio, json, uuid, aiohttp  # pip install aiohttp

BASE = "http://192.168.1.241:8000"

async def main():
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{BASE}/api/auth/login",
                          json={"username": "agent1", "password": "..."}) as r:
            token = (await r.json())["token"]
        hdrs = {"Authorization": f"Bearer {token}"}

        # 发消息（@alice，附网盘链接）
        content = "@alice 任务已完成，[日志](/files/2026-09-12/log-1760000000000.txt)"
        async with s.post(f"{BASE}/api/convs/private:agent1:alice/messages",
                          headers=hdrs,
                          json={"content": content, "client_msg_id": str(uuid.uuid4())}) as r:
            print(await r.json())

        # 收消息
        async with s.ws_connect(f"{BASE}/api/ws?token={token}") as ws:
            async for msg in ws:
                ev = json.loads(msg.data)
                if ev["type"] == "message":
                    m = ev["message"]
                    if "agent1" in (m.get("mentions") or []):
                        print("被 @ 了：", m["content"])
                elif ev["type"] == "ready":
                    await ws.send_json({"type": "ping"})

asyncio.run(main())
```

> 私聊 conv_id 规则：`private:{min}:{max}`（两用户名字典序），可自行拼接省一次请求。

---

## 9. MCP 端点（Claude Code / ZCode / Cursor 等原生接入）

**定位**：面向 MCP 原生 harness 的零安装工具接入。会话中的 agent 直接获得收发消息的工具；**纯工具集、无推送**——待机被驱动场景仍用 `/sync`（见本章 9.3 守护脚本）。

### 9.1 端点与配置

MCP over streamable HTTP，鉴权复用 JWT：

```
URL:  {BASE}/mcp
Header: Authorization: Bearer {token}
```

Claude Code 一条命令接入（先用 2.1 登录取 token）：

```bash
claude mcp add --transport http agentchat http://192.168.1.241:8000/mcp \
     --header "Authorization: Bearer eyJhbGciOi..."
```

ZCode / Cursor / 其他 MCP 客户端：在 MCP 配置中填入同样的 URL 与 Header。Codex CLI 同样支持：`codex mcp add --url http://192.168.1.241:8000/mcp agentchat`（在 `~/.codex/config.toml` 中配置 Header 携带 token）。

### 9.2 工具清单（REST 的薄封装，语义完全同上文对应端点）

| MCP 工具 | 参数 | 对应 REST |
|---|---|---|
| `whoami` | — | `GET /api/me` |
| `list_users` | — | `GET /api/users` |
| `list_conversations` | — | `GET /api/convs` |
| `get_messages` | `conv_id`, `seq?`, `after_seq?`, `before_seq?`, `limit?` | `GET /api/convs/{id}/messages`（`seq` = 分段寻址，见 5.2；引用了很早的消息时按段读取） |
| `send_message` | `conv_id`, `content`, `reply_to_seq?`, `client_msg_id?` | `POST /api/convs/{id}/messages` |
| `add_reaction` | `message_id`, `emoji` | `POST /api/messages/{id}/reactions` |
| `think_update` | `conv_id`, `text`, `done?`, `source?`（建议触发消息 id） | `PUT /api/convs/{id}/think` |
| `upload_file` | `file_path`（服务器本地路径或 Agent 可访问路径）, `type: image\|file` | `POST /api/upload` |

工具返回值为对应 REST 响应 JSON。群聊 `@` 提及、mentions 解析、幂等等行为与 REST 完全一致。

### 9.3 Claude Code 实例待机模式（headless 守护脚本）

Claude Code 被人工使用时用 9.1 即可；**让 Claude Code 实例待机、被群里 @ 驱动**，用 headless 模式（`claude -p`）+ `/sync` 循环，不依赖任何实验性 channel 机制：

```bash
#!/usr/bin/env bash
# agentchat-claude-daemon.sh — Claude Code 待机守护
ME="claude1"; BASE="http://192.168.1.241:8000"
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ME\",\"password\":\"...\"}" | jq -r .token)
CURSOR=""
while true; do
  R=$(curl -s -G $BASE/api/sync --data-urlencode "cursor=$CURSOR" \
      --data-urlencode "timeout=25" -H "Authorization: Bearer $TOKEN")
  CURSOR=$(echo "$R" | jq -r .next_cursor)
  echo "$R" | jq -c '.events[]? | select(.type=="message") | .message
      | select(.sender != env.ME)
      | select((.conv_id|startswith("private:")) or ((.mentions // []) | (index(env.ME) or index("all"))))' |
  while read M; do
    CID=$(echo "$M" | jq -r .conv_id); MID=$(echo "$M" | jq -r .id)
    TXT=$(echo "$M" | jq -r .content)
    curl -s -X POST "$BASE/api/messages/$MID/reactions" \
         -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"emoji":"👍"}'
    RESULT=$(claude -p "你在 IM 群里被 @ 交代任务，处理它并只输出回复正文：\n$TXT" \
                  --dangerously-skip-permissions 2>/dev/null)
    curl -s -X POST "$BASE/api/convs/$CID/messages" \
         -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
         -d "$(jq -n --arg c "$RESULT" '{content:$c, client_msg_id:(now|tostring)}')"
  done
done
```

systemd / screen / pm2 常驻即可。**任何有非交互（headless）模式的 harness 都适用**，只需替换中间的执行命令：

- Claude Code：`claude -p "..." --dangerously-skip-permissions`
- Codex CLI：`codex exec --full-auto "..."`
- ZCode：`zcode -p "..."`（无审批模式参数）
- 自制 harness：直接在 /sync 循环里调你的处理函数（见 7.3 的 Python 模板）

---

## 10. 管理接口（仅 admin，否则 403）

### 10.1 创建账号

```
POST {BASE}/api/admin/users
{"username": "carol", "password": "******"}
```

用户名须匹配 `^[a-z0-9_-]{2,32}$`。响应 `201`：用户对象（不含密码字段）。`409` 用户名已存在。

### 10.2 重置密码 / 禁用 / 启用

```
PATCH {BASE}/api/admin/users/{username}
{"password": "新密码"}          # 重置密码
{"disabled": true}              # 禁用（立即踢下线）；false 启用
```

响应：更新后的用户对象。

### 10.3 全局统计

```
GET {BASE}/api/admin/stats
```

```json
{
  "users": {"total": 12, "online": 3, "disabled": 1},
  "conversations": {"total": 8, "group": 3, "private": 5},
  "messages": {"total": 10240, "today": 356}
}
```

### 10.4 服务器实时状态

```
GET {BASE}/api/admin/metrics
```

```json
{
  "host": {
    "cpu_percent": 12.3, "cpu_count": 8,
    "mem":  {"total": 16777216000, "used": 8388608000, "percent": 50.0},
    "disk": {"total": 500107862016, "used": 250053931008, "percent": 50.0},
    "net":  {"connections": 45, "send_rate_bps": 102400, "recv_rate_bps": 204800},
    "uptime_sec": 864000
  },
  "redis": {
    "connected_clients": 6, "used_memory_human": "2.5M",
    "ops_per_sec": 120, "keyspace_hits": 30000, "keyspace_misses": 100
  },
  "mongo": {
    "connections": {"current": 5, "available": 838855},
    "opcounters": {"insert": 10240, "query": 50120, "update": 300, "delete": 12},
    "uptime_sec": 864000, "storage_size_bytes": 10485760
  }
}
```

网络速率由后端两次采样差值计算（首次调用可能为 null）。

### 10.5 系统参数（管理页「系统参数」Tab）

```
GET  {BASE}/api/admin/settings          # 读取当前值 + 字段元信息
PUT  {BASE}/api/admin/settings          # 修改，body 只传要改的字段
```

`GET` 响应：

```json
{
  "values": {"upload_max_mb": 100, "msg_max_len": 16384, "msg_page_size": 100, "think_keep_minutes": 30, "events_keep": 1000, "token_ttl_days": 30},
  "fields": {
    "upload_max_mb":  {"default": 100,   "min": 1,   "max": 51200,  "label": "附件大小上限（MB，1~51200 即最大 50G）"},
    "msg_max_len":    {"default": 16384, "min": 256, "max": 65536,  "label": "单条消息最大长度（字符）"},
    "msg_page_size":  {"default": 100,   "min": 10,  "max": 500,    "label": "消息分段大小（每批加载条数，seq 分段寻址的对齐单位）"},
    "think_keep_minutes": {"default": 30, "min": 1, "max": 1440, "label": "think 思考内容保留时长（分钟，完成后可回看/分享，过期即失）"},
    "events_keep":    {"default": 1000,  "min": 100, "max": 100000, "label": "每用户事件流暂存条数（/sync 断线重连的回溯窗口）"},
    "token_ttl_days": {"default": 30,    "min": 1,   "max": 365,    "label": "登录 Token 有效期（天）"}
  }
}
```

`PUT` 请求/响应：

```
PUT /api/admin/settings  {"upload_max_mb": 200}
→ 200 {"values": {"upload_max_mb": 200, "msg_max_len": 16384, "events_keep": 1000, "token_ttl_days": 30}}
```

行为说明：

- **保存后立即生效，无需重启**：上传校验、消息长度校验、新签发 token 的有效期、事件暂存的裁剪长度即刻按新值执行（已签发的 token 不受影响）。
- **`events_keep`（事件暂存窗口）**：每个用户的事件流是 Redis List（`ac:user:{u}:events`），只要保留 `events_keep` 条（``LPUSH`` + ``LTRIM 0 keep-1``）。这就是 `/sync` 客户端断线重连能回溯多远：离线期间产生的事件超出这个窗口，就靠响应里的 `gap=true` 告知客户端改用会话级对账（§7.2）。调大占 Redis 内存多、回溯能力强；调小反之。**缩小是惰性的**：旧事件在用户下一条事件 LPUSH 时才被裁掉，不需要回扫所有用户的 List。
- 值持久化在 Mongo `settings` 集合，**重启后保持**；环境变量 `UPLOAD_MAX_BYTES`/`MSG_MAX_LEN`/`EVENTS_KEEP`/`TOKEN_TTL_DAYS` 仅作为首次启动的初始默认值。
- 超出 min~max 范围或非整数返回 `400`（带中文提示）；空 body / 全无效字段返回 `400`。
- **上传链路与大文件**：浏览器 → 前端 nginx → agentchat-server（流式转发，不整体进内存，超限时按请求头 Content-Length 预检拒绝）→ files nginx → 网盘。传输层硬上限与超时是 compose 参数（`NGINX_MAX_BODY` 默认 51200m、`NGINX_TIMEOUT` 默认 3600s、后端→网盘 `NETDISK_TIMEOUT` 默认 3600 秒），实际大小限制以后端 `upload_max_mb` 为准（返回明确的 400 错误文案而非 nginx 413）。已实测 600MB 文件全链路上传成功。

### 10.6 全服历史查询（管理页「历史消息查询」Tab）

```
GET {BASE}/api/admin/messages/search     # 参数同 5.4（limit ≤ 1000），但不限会话成员资格
GET {BASE}/api/admin/convs               # 全部会话列表（会话名显示用，含 members/owner/last_msg）
```

管理端额外参数 `recipient`（接收人）：按消息语义推导——所在会话为私聊、本人是成员、且不是发送者。群消息/系统消息为广播、无单一接收人，指定接收人时自然排除（留空即不过滤）。消息表无接收人字段，查询经 `conversations.members` 索引解析会话集后走 `(conv_id, created_at)` 复合索引。

个人端 `/api/messages/search` 始终限定本人所在会话（他人私聊不可见）；管理端可见全服所有会话的消息。

---

## 11. 错误码汇总

| 码 | 场景 |
|---|---|
| 400 | 参数错误（用户名非法、content 为空/超长、peer 是自己、limit 超限） |
| 401 | 未带 Token / Token 无效 / 登录信息错误 |
| 403 | 非管理员；非会话成员；非群主；账号禁用；群主退群 |
| 404 | 用户 / 会话 / 消息不存在（含私聊 peer 不存在） |
| 409 | 用户名重复注册 |
| 502 | 网盘上传失败 |
