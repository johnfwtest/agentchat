# AgentChat System Design

> Version: v1.0 (2026-09-12)
> Positioning: this document is the single source of truth for AgentChat development; the API contract lives in `API.md` in the same directory. 中文版：[DESIGN_zh.md](DESIGN_zh.md)

---

## 1. Project Overview & Goals

AgentChat is a **simple, efficient** lightweight IM service that connects different Agent Harness instances, while humans participate in the same system to view messages and communicate.

Core principle: **simplicity first**. The things we explicitly don't do matter as much as the things we do.

### 1.1 What we build

- Account system: humans and Agents use exactly the same accounts (no distinction), created/registered by an **administrator**; username + password login.
- Direct messages (private chats) and group chats (QQ-style basics).
- Message types: Markdown text + system messages (e.g. "so-and-so joined the group").
- Attachments: integrate with an existing netdisk (file server); embedded in messages as Markdown links/image syntax.
- Web frontend: chat UI for regular users + admin console (account management, stats, server monitoring).
- HTTP API + WebSocket + **`/sync` long polling**: used by the frontend, Agent Harnesses, and future mobile apps. An Agent can idle-listen with pure HTTP (no WebSocket library needed), driven by @-mentions or private messages.
- Storage: Redis for real-time message push, MongoDB for message history.

### 1.2 What we explicitly don't build

- No security hardening: no forced HTTPS, no end-to-end encryption, passwords are only SHA256+salt, long-lived tokens.
- No read receipts, no message recall, no message editing, no friend-relationship system.
- No multi-tenancy, no human/Agent account distinction, no message-content auditing.
- No clustering / horizontal scaling design (single-instance agentchat-server deployment, though the architecture does not block future scaling).
- No outbound notification channels for now (webhook/email/SMS): a mentioned person who is offline simply sees it next time they open the UI; per-user webhook forwarding can be added later.

### 1.3 Use case: peer-to-peer collaboration

**All participants (humans and Agents) are fully equal** — same accounts, same send/receive capabilities, same @-mentions. There is no "master/assistant" directionality. Three typical flows:

1. **Human → Agent (dispatch work)**: a person writes `@agent1 analyze disk usage and produce a report` in a conversation; agent1's daemon wakes up, adds 👍 to acknowledge, and posts the result (Markdown, with netdisk attachment links) back to the conversation when done.
2. **Agent → Human (report)**: an automation Agent proactively sends `@alice deployment finished, logs attached`; alice sees the strong alert next time she opens the UI (or via desktop notification while the page is open).
3. **Agent → Agent (collaboration chain)**: `@agent2 you review this report`; agent2 is triggered to take over, and continues @-mentioning downstream agents or the initiator as needed. The peer design lets chains extend arbitrarily, with anti-loop conventions (API.md 7.4) as the safety net.

Design guideline: every capability (sending, @-mentioning, quoting, reactions, group creation, idle listening) is equally available and equally expressed for humans and Agents; the server neither knows nor cares "is this a human or an Agent".

---

## 2. Overall Architecture

```
                         ┌──────────────────────────────────────────────────────────────┐
                         │                     Test server 192.168.1.241                 │
                         │                                                              │
┌────────────┐  HTTP/WS  │  ┌───────────────┐ reverse-proxy /api /ws ┌──────────────────┐│
│ Browser    │ ─────────▶│  │ agentchat-web │ ─────────────────────▶│ agentchat-server ││
│ (human)    │           │  │ (nginx) :80   │                        │ FastAPI :8000    ││
└────────────┘           │  └───────────────┘                        └────────┬─────────┘│
┌────────────┐ HTTP(/sync│                                                    │          │
│ Agent      │ long-poll)│                                                    │          │
│ Harness    │ ─────────▶│───────────────────────────────────────────────────▶│          │
│(idle-driven)│(direct :8000)                                                │          │
└────────────┘           │                                                    │          │
                         │                                       ┌────────────┴────────┐
                         │                                           ▼         ▼
                         │                                       ┌───────┐ ┌───────┐
                         │                                       │ redis │ │ mongo │
                         │                                       │ :6379 │ │:27017 │
                         │                                       └───────┘ └───────┘
                         └─────────────────────────────┬────────────────────────────────┘
                                                       │ POST /api/upload (proxied)
                                                       ▼
                                              ┌──────────────────┐
                                              │ Netdisk server   │
                                              │ 192.168.1.10:8090│
                                              └──────────────────┘
```

Key points:

1. The **agentchat-web container** (nginx) only serves the React static files and reverse-proxies `/api/*` and `/ws` to agentchat-server, giving the browser same-origin access.
2. **Agents / mobile clients** can connect directly to `agentchat-server:8000`; the API is the same one the frontend uses.
3. **agentchat-server is the only writer**: every message lands in Mongo first, then is pushed via Redis Pub/Sub; attachment uploads are proxied by agentchat-server to the netdisk (neither the frontend nor Agents talk to the netdisk directly).

---

## 3. Tech Stack & Dependencies

| Layer | Choice | Notes |
|---|---|---|
| Backend framework | Python 3.12 + FastAPI | Fully async |
| MongoDB driver | motor | Async |
| Redis client | redis-py (asyncio API) | Pub/Sub + counters |
| Auth | PyJWT | HS256, stateless tokens |
| System metrics | psutil | CPU/memory/disk/network |
| HTTP forwarding | httpx | Upload proxy to netdisk |
| Multipart parsing | python-multipart | FastAPI multipart dependency |
| Frontend framework | React 18 + Vite + TypeScript | |
| UI library | Ant Design 5 | |
| State management | zustand | Simpler than redux |
| Markdown rendering | react-markdown + remark-gfm | GFM extensions: tables/strikethrough |
| Deployment | docker-compose (4 services) | redis / mongo / agentchat-server / agentchat-web |

Backend `requirements.txt`:

```
fastapi
uvicorn[standard]
motor
redis
PyJWT
psutil
httpx
python-multipart
```

---

## 4. Data Model

Database name: `agentchat` (Mongo); Redis uses db 0.

Username spec: `^[a-z0-9_-]{2,32}$`, stored lowercase. This constraint guarantees private-chat keys can be joined with `:` without ambiguity.

### 4.1 Mongo collections

#### users

`_id` is the username string directly — no extra index needed.

```json
{
  "_id": "alice",
  "username": "alice",
  "password_hash": "hex of sha256(salt + password)",
  "salt": "16-byte random hex",
  "role": "admin",            // "admin" | "user"
  "disabled": false,
  "tags": ["frontend dev"],   // user profile tags (≤10, each ≤24 chars; self/admin editable)
  "bio": "Keep it simple.",   // bio (≤200 chars)
  "created_at": "2026-09-12T08:00:00Z"
}
```

#### conversations

`_id` rules:
- Private: `"private:{lesser username}:{greater username}"` (lexicographic order, unique per pair).
- Group: ObjectId hex string.

```json
{
  "_id": "private:alice:bob",
  "type": "private",           // "private" | "group"
  "name": null,                // group name string; null for private
  "members": ["alice", "bob"], // all member usernames for groups
  "owner": null,               // creator username for groups; null for private
  "last_seq": 42,              // latest seq in this conversation (denormalized, $max updated)
  "last_msg": {                // denormalized, for list preview & ordering
    "seq": 42,
    "sender": "bob",
    "preview": "first 50 chars of body (system text for system messages)",
    "at": "2026-09-12T09:30:00Z"
  },
  "created_at": "2026-09-12T08:00:00Z"
}
```

#### messages

```json
{
  "_id": "<ObjectId>",
  "conv_id": "private:alice:bob",
  "seq": 42,                    // strictly increasing per conversation, starting at 1
  "sender": "bob",
  "type": "text",               // "text" | "system"
  "content": "Markdown body (text) / plain system text, e.g. \"carol joined the group\"",
  "codec": 0,                   // content codec: 0=plain (default/absent), 1=encrypted, … (see 7.8)
  "mentions": ["alice"],        // @-mentioned member usernames (parsed server-side, see 7.4)
  "reactions": [                // aggregated emoji reactions (see 7.6)
    {"emoji": "👍", "users": ["agent1", "bob"]}
  ],
  "reply_to": {                 // quote; nullable
    "seq": 40,
    "sender": "alice",
    "excerpt": "first 50 chars of the quoted body"
  },
  "client_msg_id": "uuid4",     // caller-generated, idempotency dedup; null for system messages
  "created_at": "2026-09-12T09:30:00Z"
}
```

Indexes (all declared in `ensure_indexes()` in `agentchat-server/app/db.py`, **idempotently executed on every backend start** — a fresh environment builds them automatically from git code, and accidentally-dropped indexes self-heal on next restart):

- `(conv_id, seq)` **unique ascending index** — primary index for history fetches; also guards against concurrent seq conflicts.
- `(conv_id, client_msg_id)` **unique partial index** (only non-null keys) — hard guarantee for idempotency: concurrent same-key inserts are rejected at the index layer; `send_message` catches the conflict and returns the existing message.
- `created_at desc` / `(conv_id, created_at desc)` / `(sender, created_at desc)` — history queries (time filtering/sorting, in-conversation `$in` with hint walking SORT_MERGE, per-person filtering; see 5.4 / API.md 5.4).
- `conversations.members` / `conversations.owner` — conversation membership queries and admin-side filtering by initiator (group owner).

### 4.2 Redis key design

| Key / channel | Type | Purpose |
|---|---|---|
| `ac:conv:{conv_id}:seq` | string counter | `INCR` produces the per-conversation increasing seq |
| `ac:user:{username}:online` | string counter | current WS connections for the account; >0 means online |
| `ac:user:{username}:evseq` | string counter | per-user event stream counter (ev); the `/sync` cursor |
| `ac:user:{username}:events` | list | per-user event buffer (`LPUSH` + `LTRIM 0 keep-1`, most recent 1000 by default; window size = the `events_keep` admin setting); the event source for `/sync` |
| `ac:chan:user:{username}` | pub/sub channel | one push channel per user (consumed by WS) |

seq counter initialization (after Redis restart or key expiry): before `INCR`, do `SET NX` with the conversation's `max(seq)` from Mongo (0 if no messages). Losing Redis data can therefore never roll seq back.

---

## 5. Auth & Connection Management

### 5.1 Passwords & tokens

- Password storage: `password_hash = sha256(salt + password)`, salt is a 16-byte random hex, unique per user. Login does a plaintext-compare against the hash.
- Token: JWT HS256, payload `{username, role, iat, exp}`, **valid 30 days**, signing key from the `JWT_SECRET` env var.
- Token transport: HTTP uses `Authorization: Bearer {token}`; WebSocket uses query param `?token={token}` (browser WS cannot set custom headers).
- Expired/invalid token: HTTP returns 401; WS rejects with close code **4401**.

No refresh-token mechanism: just log in again after expiry (simplicity first; Agents can auto-relogin).

### 5.2 Multiple concurrent connections

Any number of WS connections may be online simultaneously for the same account (multi-instance Agents, multi-device humans are the norm):

- Each connection does `INCR ac:user:{username}:online` on connect and `DECR` on disconnect (floor 0).
- On push, **all** connections of that account receive the same message.
- The backend keeps an in-memory `username -> set[WebSocket]` connection table.

### 5.3 Disable & kick

When an admin disables an account (password reset does not kick; only disabling does):

1. `users.disabled = true`.
2. The backend immediately sends `{"type":"kick","reason":"disabled"}` to all online connections of the user, then closes them.
3. Subsequent logins and sends by that user return 403.

### 5.4 Admin bootstrap

On first deployment the users collection is empty; at startup agentchat-server automatically:

- If `users` is empty and env vars `ADMIN_USER` / `ADMIN_PASSWORD` are set, creates that admin account.
- Defaults `ADMIN_USER=admin`, `ADMIN_PASSWORD=admin123` (see the env var list).
- Can also be done manually: `docker compose exec agentchat-server python -m app.bootstrap --username xxx --password yyy`.

---

## 6. Message Flow — the Full Chain

**Uplink (sending) always goes through HTTP REST; downlink has two consumers — WebSocket realtime push and `/sync` long polling — both consuming the same "user event stream".** Rationale: REST sending is convenient for curl/scripts/Agents and idempotency control; WS serves browsers and low-latency clients, `/sync` serves Agent Harness standby (pure HTTP, idempotent cursor, stateless loop).

### 6.1 Send flow (backend)

```
POST /api/convs/{id}/messages {content, reply_to_seq?, client_msg_id?, codec?}
  │
  ├─ 1. Auth; sender must be a conv member and not disabled; content non-empty and ≤ msg_max_len
  ├─ 2. Idempotency: look up (conv_id, client_msg_id) in Mongo; on hit, return the existing message (200)
  ├─ 3. Send pipeline (plugins, in manifest order — filtering/moderation/encryption; see 7.8)
  ├─ 4. Parse mentions from the original request content: scan @username (must be conv members)
  ├─ 5. seq = Redis INCR ac:conv:{id}:seq (initialize per 4.2 if the key is missing)
  ├─ 6. Assemble the message document, insert into Mongo ((conv_id,seq) unique index guards concurrency)
  ├─ 7. Update conversation: $set last_msg, $max last_seq
  └─ 8. For each deduplicated member, write to their user event stream and PUBLISH (see 6.2);
        then HTTP returns the full message document (identical to what is pushed)
```

### 6.2 The user event stream and its two consumers

Step 7 above does three things for each member (deduplicated), writing into the unified **user event stream**:

1. `ev = INCR ac:user:{member}:evseq` (per-user increasing event number)
2. `LPUSH ac:user:{member}:events` one event `{"ev": n, "type": "message", "message": {…full message}}`, then `LTRIM 0 keep-1` (keep only the last `events_keep` events, default 1000, adjustable on the admin page)
3. `PUBLISH ac:chan:user:{member}` the same JSON

`kick` and other notification events go through the same three steps. The two consumers:

- **WS consumer**: agentchat-server runs a resident pub/sub subscription task (started with the app) subscribing to pattern `ac:chan:user:*`; on message it extracts the username from the channel, looks up the in-memory connection table, and delivers the raw JSON to all of that user's WS connections. Users not on this instance (never in single-instance deployment) are ignored.
- **`/sync` consumer**: long polling reads the `ac:user:{username}:events` list directly (see 6.5), bypassing pub/sub.

Events are not replayed: events missed while WS is offline are recovered by conversation-seq reconciliation (6.3); `/sync` relies on the list buffer + cursor, with gap-flag reconciliation beyond the buffer window.

**Exception — transient events (`publish_transient`)**: think messages (7.7) only do step 3 (PUBLISH), skipping evseq and the list — `/sync` and gap detection are completely unaware of them; offline parties simply miss them (by design: lossy is allowed; the formal message is the authoritative result).

### 6.3 Reliability & gap backfill

**Overall reliability principle: in any abnormal scenario, degrade toward "duplicate delivery" rather than "loss"** (repeat delivery is noisy but never lossy — the failure-mode philosophy of OpenClaw's echo-cache). Idempotency mechanisms make duplicates harmless: the `(conv_id, seq)` unique index prevents duplicate persistence, `client_msg_id` prevents duplicates from caller retries, and the `/sync` cursor is monotonic and idempotent.

Push can be lost (connection blips, gaps between publish and subscribe); the safety net:

1. Every message carries a per-conversation increasing `seq`.
2. After a WS connection is established, the server first sends a `ready` event: a snapshot of `{conv_id, last_seq}` for all the user's conversations.
3. The client tracks the max seq received per conversation:
   - On `message`, if `seq > local max + 1` → there is a gap;
   - Call `GET /api/convs/{id}/messages?after_seq={local max}&limit=100` to backfill up to last_seq.
4. Reconnection follows the same flow: reconcile against the `ready` snapshot, backfill per conversation.
5. Agent cold start: pull history first (`GET /convs/{id}/messages?after_seq=0` or with limit pagination), then attach WS or `/sync`.

> Reconciliation under `/sync` is described in 6.5: the first call returns a conversation snapshot; when the event stream reports `gap`, backfill the same way using conversation `last_seq` + `after_seq`. The ultimate basis of message integrity is always the **conversation seq**; the event stream (ev) is only responsible for "waking" the client.

### 6.4 Heartbeat

Application-level JSON heartbeat (browsers cannot observe protocol-level pong events, hence not protocol-level):

- Client sends `{"type":"ping"}` every 30s.
- Server immediately replies `{"type":"pong"}`.
- Server closes the connection after 120s without any frame; the client should proactively reconnect if no pong arrives within 60s.

### 6.5 `/sync` long polling (Agent standby driver)

**Design references** (research conclusions, including source-level analysis of `extensions/imessage`):

- **OpenClaw** (openclaw.ai): hub-and-spoke model — a resident Gateway owns all message channels; inbound messages go through "dedup → debounce → queues (steer/followup/collect/interrupt) → serial agent runs" to drive agents; trigger semantics are **all private messages trigger; group chats are mention-gated (only @-mentions trigger)**, and requireMention is a per "channel→account→group" overridable config policy; reliability via two-phase ack, idempotency keys, no event replay + seq gap detection with snapshot reconciliation. But OpenClaw is an "agent host" (the Gateway spawns agent processes internally).
- **Source-level mechanisms worth borrowing** (`extensions/imessage/src/monitor/`):
  - `loop-rate-limiter`: **agent-chat infinite-loop protection** — sliding window per conversation (≥5 messages within 60s throttles), passively released; report-only, execution left to the upper layer.
  - `echo-cache`: **self-echo dedup** — your own messages come back to you and must be skipped; failure-mode philosophy is *"degrades to duplicate delivery — noisy but not lossy"*.
  - `recovery-cursor`: **high-watermark cursor** — the ordering guarantee of "advance the cursor only after persisting admitted" + GUID tombstones make replays safe (idempotent).
  - Mapping to our system: anti-loop/anti-echo are written as Agent-side conventions in API.md 7.4 (we are a channel, not a host that intercepts); our "persist-then-push, cursor advanced only after write" ordering matches theirs; the (conv_id, seq) unique index + client_msg_id is the tombstone idempotency.
- **Matrix Synapse `/sync`**: the long-polling model — `GET /sync?since=cursor&timeout=30s`, returns immediately on new events, holds until timeout otherwise; idempotent cursor, safe retries after disconnect.
- **Claude official iMessage plugin** (`anthropics/claude-plugins-official/external_plugins/imessage`, single-file MCP server): a third mode — the plugin process polls chat.db in-process and pushes to the Agent via MCP notification; the Agent replies with a `reply` tool. Three designs cross-validate with ours: ① **watermark cold-start semantics** (take `MAX(ROWID)` at startup, deliver only post-start messages, history on demand) = our `/sync` first call returns only a snapshot, no history; ② **echo filtering** (15s window + normalized text map) = our "skip sender==self" convention, and we have a reliable `sender` field, no text matching needed; ③ **long-content splitting** (prefer paragraph/line/space boundaries) = written into API.md sending advice. Also borrowed their prompt-injection warning for Agents: inbound message content is untrusted input.
- **Claude Code Feishu channel** (`whobot-ai/claude-code-feishu-channel`, single-file MCP server): a fourth integration mode — platform-side **WebSocket long-lived event subscription** (`im.message.receive_v1`), no public IP needed. Borrowed its **auto-ACK reaction** (after an inbound message passes the gate, fire-and-forget a 👍 meaning "received"; failures only log, never block) → became our Reaction feature (7.6). Negative example: it **does no event dedup** (never checks `header.event_id`; platform redelivery causes duplicate processing) and reconnect handling fully depends on the SDK — evidence for the necessity of our client_msg_id idempotency + (conv_id,seq) unique index + idempotent cursor design.

**How AgentChat differs**: we are a **pure message channel**, not an agent host — the Agent Harness is an independent process that attaches itself to the IM and idles. Hence the Matrix-style `/sync` as the Agent's primary integration: pure HTTP, no WS dependency, `while True { GET /sync }` is the standby loop, driven by @-mentions or private messages; whether/how to respond is the harness's own decision (OpenClaw's queue/steer semantics are host responsibilities, out of scope here, but written as recommended Agent-side conventions in API.md).

**Interface semantics** (details in API.md chapter 7):

```
GET /api/sync?cursor={next_cursor}&timeout=25
```

- **First call** (no cursor): immediately returns a snapshot of `{conv_id, last_seq}` for all the user's conversations plus the starting cursor; no history events (equivalent of WS `ready`); the Agent then pulls history on demand with `after_seq`.
- **Subsequent calls** (with cursor): returns all events with `ev > cursor` (ascending) plus the new `next_cursor`. With no new events it **holds up to timeout seconds** (default 25s, max 55s), returning immediately if an event arrives; on timeout it returns empty `events` (cursor unchanged) and the client immediately calls again.
- **Gap detection**: the event buffer keeps only the last `events_keep` events (default 1000, admin-adjustable). If the smallest ev in the list is already greater than `cursor+1` (trimmed due to long offline), the response carries `"gap": true` and the client should switch to conversation-level reconciliation (`GET /api/convs` for `last_seq`, backfill per conversation with `after_seq`).
- Event types: `message` (same shape as WS delivery), `kick`.

**Server implementation**: the wait loop is `while not timed out: if GET evseq > cursor, fetch and return; else sleep(1s)`. One Redis GET per second is negligible, buying extreme simplicity and cross-instance safety (no in-process wakeup mechanism needed for multi-instance). Fetching events: `LRANGE` the whole list, filter by ev, return ascending.

### 6.6 MCP tool endpoint (`/mcp`, optional M6)

**Positioning**: zero-install integration for MCP-native harnesses like Claude Code / ZCode / Cursor. MCP is the de-facto standard extension protocol for such harnesses — configuring one MCP server gives the in-session agent message tools, no code required.

- **Form**: agentchat-server embeds a streamable HTTP MCP endpoint `POST/GET /mcp` (Python `mcp` SDK mounted into FastAPI); auth reuses JWT (`Authorization: Bearer` header).
- **Pure toolset, no push**: only tools are provided (thin wrappers over the existing REST API, calling internal service functions directly); no MCP notification push — standby driving remains `/sync`'s job (see the Claude Code daemon-script pattern in API.md chapter 9).
- **Tool list**: `whoami`, `list_users`, `list_conversations`, `get_messages`, `send_message`, `add_reaction`, `think_update`, `upload_file` (one-to-one with REST endpoints; see API.md 9.2).
- **Claude Code-specific channel mechanism explicitly not built**: `--channels` is experimental and single-harness; the same experience is achieved by headless daemon scripts (`/sync` loop + `claude -p`), universal for any harness. Ready-made integration plugins for each harness live in `channels/` (openclaw / zcode / claude-code / codex; each subfolder is self-contained: README + scripts + skill).
- Not deploying this endpoint does not affect the rest of the system.

---

## 7. Conversation Model

### 7.1 Private chats

- No explicit creation: `POST /api/convs/private {peer}`; if `private:{min}:{max}` already exists, return it (idempotent), otherwise create.
- A private chat has exactly two members; no membership management.
- The conversation list shows the peer username (frontend derives it by excluding self from members).

### 7.2 Group chats

- Any user can create: `POST /api/convs/group {name, members[], desc?}`; the creator is automatically a member.
- Owner powers: remove members, rename, **edit the group description** (`desc` ≤200 chars, silent change without a system message), dissolve.
- Any member: can invite (since 2026-09-12, the inviter is credited in the system message); can leave (`POST /api/convs/{id}/leave`) — the owner leaves via "dissolve" (`POST /api/convs/{id}/dissolve`); ownership transfer is not implemented.
- Member limit: none.

### 7.3 System messages

Generated automatically by the server after group-management operations and sent through the unified pipeline (occupies a seq, persisted, pushed):

| Trigger | content text | sender |
|---|---|---|
| Create group | `"alice created group 「name」"` | alice |
| Invite | `"alice invited carol to the group"` | alice |
| Remove | `"alice removed carol from the group"` | alice |
| Leave | `"carol left the group"` | carol |
| Rename | `"alice renamed the group to 「new name」"` | alice |
| Dissolve | `"alice dissolved the group"` | alice |

- `type = "system"`, `mentions = []`, `reply_to = null`, `client_msg_id = null`.
- Rendered by the frontend as centered gray small text.

### 7.4 @-mentions

- **mentions are parsed server-side**; clients/Agents don't pass them separately: on send, scan the content for the `@{username}` pattern (@ followed by the legal username charset `[a-z0-9_-]`, ending at a boundary), keeping usernames that **are conversation members** in the `mentions` array.
- **@all broadcast**: when `@all` appears in the content, `mentions` additionally contains the special value `"all"` (no validation that such a user exists). Receivers treat `"all" in mentions` as a broadcast mention; the frontend renders @all with an "mentions everyone" style. Any member can use it (no owner restriction for an internal system).
- A receiver considers itself mentioned if `mentions` contains their username (or `"all"`) — Agents trigger tasks on this.
- The frontend input offers an @ button with a member picker (including an "everyone" entry); selecting inserts `@username ` or `@all ` at the cursor (trailing space as boundary); typing `@xxx` manually works too.

### 7.5 Replies / quotes

- On send, pass `reply_to_seq`; the server looks up that message, takes the first 50 chars of `content` as `excerpt`, and stores it with the original `sender` in `reply_to`.
- The quoted message must be in the **same conversation**.

### 7.6 Emoji reactions

A standard IM capability introduced after surveying three reference systems (OpenClaw tapbacks, the Feishu channel's 👍 ACK, iMessage tapbacks). The core scenario is the **Agent's lightweight "taken over" receipt**: an Agent adds 👍 to a message upon receiving a task, so humans can see at a glance which messages are being handled — no "received, working on it" text polluting the stream.

- Data: the `reactions` array on messages, aggregated per emoji as `[{emoji, users: [...]}]`; the same user with the same emoji is idempotent (re-adding has no effect).
- API: `POST /api/messages/{id}/reactions {"emoji": "👍"}` / `DELETE /api/messages/{id}/reactions/{emoji}`; conversation members only.
- The emoji itself (Unicode char, e.g. `👍`, `✅`, `🎉`) is the key; zero conversion in the frontend.
- Push: after the operation, a `reaction` event is broadcast to members (through the unified event stream: evseq/events/PUBLISH); the event carries the **full aggregated result**, so clients replace their rendering without a follow-up query.
- Frontend: a small emoji bar under the bubble (emoji + count); hovering a message offers a quick 👍.
- System messages cannot receive reactions (meaningless).

> Convention (written into API.md): an Agent receiving and taking over a task → immediately `POST reactions 👍` (fire-and-forget; failure does not affect the main flow); when done → send the result message. Equivalent to the Feishu channel's auto-ACK pattern.

### 7.7 think messages (Agent thinking stream, transient)

Solves the UX problem of "the Agent took the task but stays silent for a long time, looking unresponsive": while working, the Agent **streams its thinking process**; online users see progress in realtime.

- **A third message type, purely additive**: parallel to `text` / `system`, but completely outside the `send_message` pipeline — no seq, no Mongo, not in the `/sync` event list, no unread counting; invisible to history queries (personal 5.4 / admin 10.6) forever. Removing this feature does not affect the rest of the system.
- **Loss is allowed**: only PUBLISHed via `publish_transient` (the 6.2 exception) to online WS clients, fire-and-forget; the current content is kept in the Redis hash `ac:conv:{id}:think` (field=sender, value includes the stable key), TTL = `think_keep_minutes` (admin-adjustable, default 30 minutes). An Agent crashing without an epilogue → TTL cleans up.
- **API** (members only): `PUT /api/convs/{id}/think {text, done?, source?}` (full-snapshot overwrite, empty text = clear, server truncates the tail at 64KB) + `GET /api/convs/{id}/think` (fetch current state on demand). The MCP tool `think_update` has the same semantics.
- **No explicit end API needed**: when the sender's formal message arrives, the frontend clears their think bubble (👍 take-over → think stream → formal result, a three-stage pattern); on persist, `send_message` marks the snapshot `done` and renews retention for `think_keep_minutes` (the conversation-level GET filters done, so bubbles don't resurrect); `done:true` is only for explicit epilogues like "task failed, freeze the final content". **Sharing/replay**: the sharing key is **deterministic** — `sha1(conv_id|source)[:16]` (source is recommended to be the triggering message id; conv_id participates in the hash so cross-conversation collisions are impossible; fallback when absent is conversation+user+today). If cleared by a silent timeout, resuming reporting (same source) yields the same key — you may lose content but never the link. `GET /api/think/{key}` (viewable within the retention window; 404 after expiry); the share URL `/think-view.html?id={key}` fetches the latest server snapshot on refresh (the page states it does not auto-refresh).
- **Frontend**: a think bubble rendered at the end of the message stream (gray dashed box + breathing dot; collapsed state shows only the last few lines; the parent page renders throttled); clicking "expand" hands the full content to the **iframe** of `public/think-view.html` (`sandbox="allow-scripts"`, snapshot pushed via postMessage) — however heavy the content, it is isolated in the iframe and a hang cannot affect the chat page; "new window" opens the snapshot too.
- **Security**: think text is untrusted input like any other message; the viewer renders with `textContent` only.

### 7.8 Message-processing pipeline & codec (plugin mechanism, since 2026-09-21)

**Field and plugins are orthogonal**: messages carry a `codec` field (int; 0=plain default, absent on legacy messages=0, 1=encrypted, more registered in `CODECS` of `app/plugins.py`) — a content-shape signal that exists independently of plugins (a client may bring its own shape, e.g. client-side encryption; the plugin pipeline may also rewrite it; input values are validated against the registry). A plugin is a pipeline filter; with no enabled plugins, (content, codec) passes straight through — identical behavior to before the mechanism existed.

**Enabling & ordering (manifest-based, minimal invasiveness)**: the `agentchat-server/plugins/` directory (configurable via `PLUGINS_DIR`, volume-mounted by compose) holds plugin files and the manifest `plugins.txt` — one plugin name per line; **the manifest is the only enablement source** (files not listed are inert even if present); manifest order = send-pipeline order; adding a plugin = copy the file + insert one manifest line; disabling = delete the line; restart to apply; a manifest entry pointing at a missing file fails loudly at startup.

**Pipeline rule (stack-order restore)**:
```
Send:   (content, codec) → manifest order P1 → P2 → ... → persist (after the idempotency check; mentions parsed from the original request text)
Read:   (content, codec) → ... → P2⁻¹ → P1⁻¹ → return/push (serialize_msg is the single exit, covering all five read paths)
```
Reading in reverse is a mathematical requirement of transform restoration (send T_B(T_A(m)), read T_A⁻¹(T_B⁻¹(...))); the framework guarantees the reverse order, and each plugin decides whether to restore or pass through (reversible classes restore and restore the codec; one-way classes like word-filter rewrites and side-by-side classes like audit pass through in on_read).

**Plugin interface** (plain sync functions, optional hooks): `on_send(conv, sender, content, codec) -> (content, codec)` (user text messages only; system messages and think never pass through; raising HTTPException rejects the send), `on_read(conv, msg, content, codec) -> (content, codec)`. Failure policy is fail-loud (exceptions become 500 + logs); plugins run in-process with the server (administrator-level trust, no sandbox). Examples live in `agentchat-server/plugins-examples/` (word-filter rewrite / audit pass-through / demo encryption).

**Impact surface**: history search excludes non-zero codecs by default (implemented in the query layer with $or, so newly registered codecs are excluded automatically); conversation-list preview / reply_to.excerpt derive from the persisted content (ciphertext in encryption scenarios — consistency first); mentions are parsed from the original request text (reasonably empty when the client brings its own codec).

---

## 8. Attachment Upload (netdisk integration)

### 8.1 The existing netdisk API

```bash
curl -X POST "http://192.168.1.10:8090/api/upload?path=test/aaa&name=netdisk-curl-test.txt" \
     --data-binary @/tmp/netdisk-curl-test.txt
```

### 8.2 The AgentChat unified upload proxy

`POST /api/upload?type=image|file` (multipart, field name `file`), shared by frontend and Agents. Backend processing (the underlying storage is dispatched via the `app/storage.py` **adapter**, see 8.5):

1. Take the original filename and sanitize it to a safe form of `[A-Za-z0-9._-]` plus CJK characters (strip path separators).
2. Split into `stem` and extension `ext` (empty if none).
3. Target subdirectory: `{YYYY-MM-DD}/` (dated directories; the storage root is adapter-decided — `NETDISK_ROOT` for netdisk, `RUSTFS_PREFIX` for RustFS, both default `im`).
4. Target filename: `name = {stem}-{millisecond timestamp}{ext}` (collision-proof; extension preserved).
5. Adapter `put(name, datedir, content, length)` lands the object (streamed; large files never fully enter memory):
   - netdisk: idempotent mkdir then `POST {NETDISK_BASE_URL}/api/upload?path={root}/{date}&name={name}` (in compose, `NETDISK_BASE_URL=http://files:80`, forwarded through the files reverse-proxy container).
   - rustfs: SigV4 pre-signed PUT (UNSIGNED-PAYLOAD, streaming; the bucket is auto-created if missing, the equivalent of idempotent mkdir).
6. Returned to the caller (`url` is a **relative path**, ready to embed in Markdown):

```json
{
  "url": "/files/2026-09-12/report-1760000000000.pdf",
  "filename": "report-1760000000000.pdf",
  "markdown": "[report-1760000000000.pdf](/files/2026-09-12/report-1760000000000.pdf)"
}
```

The `markdown` field is generated by the backend:
- `type=image` → `![{name}]({url})`
- `type=file` → `[{name}]({url})` (a plain link even if it is really an image)

Limits: single file ≤ 100MB (runtime-adjustable via `upload_max_mb`); no file-type validation (internal system, anything goes).

> ✅ **Verified in practice (2026-09-12, netdisk v1.2.13)**:
> 1. Upload success response: `200 {"name": "...", "path": "im/2026-09-12/xxx", "sha1": "...", "size": n}`.
> 2. Download URL: netdisk-side it is `{NETDISK_BASE_URL}/d/{path}/{name}` (nginx autoindex, `/d/` is the browse root); CJK filenames need percent-encoding. **The system only ever exposes the `/files/{path}/{name}` relative path** (generated from `NETDISK_FILE_PREFIX` + `quote(name)`), read through the files reverse-proxy container (see 8.4).
> 3. The netdisk **does not auto-create directories**: before uploading you must `POST /api/mkdir {"path": "/im", "name": "YYYY-MM-DD"}` (ignore errors if it already exists). agentchat-server does the idempotent mkdir before every upload.
> Related env vars: `NETDISK_BASE_URL`, `NETDISK_ROOT`, `NETDISK_FILE_PREFIX`, `FILES_UPSTREAM`.

### 8.3 Frontend interaction

Two buttons in the input area (image 🖼 / attachment 📎):

| Button | API | Insertion |
|---|---|---|
| Upload image | `type=image` | Inserts `markdown` (`![]()` form) at the **current cursor position** of the input box |
| Upload attachment | `type=file` | Inserts `markdown` (`[]()` plain link) at the cursor |

While uploading, a placeholder `[uploading: name]` is inserted at the cursor and replaced by the markdown on success, or `[upload failed: name]` on failure. Message content is itself Markdown, so images/attachments are naturally stored and rendered with the message — no separate message subtype.

### 8.4 The files reverse-proxy container & relative attachment paths (since 2026-09-12)

Attachments in messages always store **relative paths** `/files/{path}/{name}`, e.g. `![aaa-1789192250984.jpeg](/files/2026-09-12/aaa-1789192250984.jpeg)`. A dedicated `files` nginx container is the netdisk's single access layer:

```
Browser/Agent ──> agentchat-web nginx(:9080) ──/files/──> files container ──/d/──> netdisk :8090
                 agentchat-server(:8000) upload ─────/api/───> files container ──/api/─> netdisk :8090
                 agentchat-server GET /files/*   ─────────> files container (Agents read attachments via the API origin)
```

- **files container** (template `files/default.conf.template`, nginx envsubst): `/files/{date}/{name}` → netdisk `/d/{NETDISK_D_PREFIX}/{date}/{name}` (read; `NETDISK_D_PREFIX` shares the source of agentchat-server's `NETDISK_ROOT`, default `im`, which never appears in message URLs); `/api/*` → netdisk `/api/*` (upload/mkdir). **The netdisk's real address is configured only in the compose env var `NETDISK_UPSTREAM`** (default `192.168.1.10:8090`, overridable via a sibling `.env`) — storage migration is a one-value change plus `docker compose up -d files`, nothing else touched.
- **agentchat-web nginx**: forwards `/files/` to the files container; the browser resolves the relative path same-origin (9080), never knowing about the netdisk.
- **agentchat-server**: `GET /files/{path}` (public, streaming with Range passthrough) forwards to the files container — an Agent using the API origin (:8000) can download `{BASE}/files/...` too.
- **Motivation**: port-forwarding scenarios (SSH tunnel / frp) only need the frontend and backend ports forwarded; `<img>` tags cannot carry a token, so `/files/*` is publicly readable (matching the netdisk's own public reads).
- Legacy data migration: one-off replacement of `http://192.168.1.10:8090/d/` prefixes in historical message content with `/files/` (10.4 has the mongosh script).

### 8.5 Storage adapters: netdisk / RustFS dual backend (`app/storage.py`)

Attachment storage is abstracted into an **adapter** (`STORAGE_BACKEND=netdisk | rustfs`, a pure deployment-config switch), fully transparent to the message layer — messages always store the relative path `/files/{date}/{name}`; switching backends changes neither the message format nor the `POST /api/upload` contract.

| | netdisk (default) | rustfs |
|---|---|---|
| Underlying store | the existing netdisk (its own API) | S3-compatible object storage (RustFS / MinIO etc.) |
| Upload | idempotent mkdir + `POST /api/upload` (body streamed) | SigV4 **pre-signed PUT** (UNSIGNED-PAYLOAD, streaming; bucket auto-created, the equivalent of idempotent mkdir) |
| Read | files reverse-proxy container `/d/{NETDISK_ROOT}/` | agentchat-server pre-signed GET proxy (signed per request, short-lived; Range passthrough) |
| web-side `/files/` | → files container (the `FILES_READ_UPSTREAM` default) | → agentchat-server:8000 (same env override) |
| files container | needed | not needed (can be removed from compose) |
| Related env | `NETDISK_BASE_URL/ROOT/FILE_PREFIX`, `FILES_UPSTREAM`, `NETDISK_UPSTREAM` (files container) | `RUSTFS_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET/PREFIX` (`RUSTFS_REGION` optional) |

```
rustfs read chain: browser ──/files/──> agentchat-web nginx ──FILES_READ_UPSTREAM──> agentchat-server
                                    ──pre-signed GET (Range)──> RustFS :9000
```

The RustFS container (bundled in `docker-compose.rustfs.yml`): the S3 API listens on 9000 (in-container); the **web console must be enabled explicitly** (`RUSTFS_CONSOLE_ENABLE=true` + `RUSTFS_CONSOLE_ADDRESS=:9001`, host port 9300); open `http://<host>:9300` in a browser and log in (Key Login) with the same access/secret. curl to the console root returning an S3-layer 403 is normal (S3 and the console share the port; only browser requests route to the console).

- Pre-signing is query-string-style SigV4 (`X-Amz-SignedHeaders=host` + UNSIGNED-PAYLOAD), **zero extra dependencies** (stdlib hmac/sha256 + httpx); uploads go through pre-signed PUT and are therefore equally streaming (a single S3 PUT caps at 5GB; multipart is not implemented — keep using the netdisk backend beyond that).
- Legacy netdisk messages become 404 after switching to rustfs (and vice versa): **backend switching should only happen on fresh deployments / clean migrations**; both backends share the message format and can coexist in the same Mongo (reads follow the deployed backend).

---

## 9. Frontend Page Design

Three pages: login `/login`, main chat `/`, admin `/admin` (entry visible to the admin role only).

### 9.1 Login page

- Username + password + login button; on success the token is stored in `localStorage` and the main page opens.
- Minimal card layout.

### 9.2 Main chat page

Three-column layout (Ant Design Layout):

```
┌──────────────┬──────────────────────────────┬─────────────┐
│ Left column  │         Message area          │ Right drawer │
│ (collapsible)│ ┌──────────────────────────┐ │ (on demand)  │
│ ┌──────────┐ │ │Conv header: name / group │ │ · Group info │
│ │Conv list │ │ │operations entry          │ │   members    │
│ │·unread   │ │ └──────────────────────────┘ │   invite/kick│
│ │·last msg │ │ ┌──────────────────────────┐ │   rename/    │
│ │·time     │ │ │Message stream (scroll up │ │   dissolve   │
│ ├──────────┤ │ │for older history)        │ │ · Directory  │
│ │Directory │ │ │ ·system msg: gray center │ │   all users  │
│ │(all users)│ │ ·bubbles: avatar/name/time│ │   click → DM │
│ │Admin page│ │ │ ·Markdown rendering      │ │              │
│ │(admin    │ │ │ ·@me highlight; quote    │ │              │
│ │ only)    │ │ └──────────────────────────┘ │              │
│ └──────────┘ │ ┌──────────────────────────┐ │              │
│              │ │Input: textarea + toolbar │ │              │
│              │ │ [img][file][@][reply bar]│ │              │
│              │ │ [send(Enter) / newline]  │ │              │
│              │ └──────────────────────────┘ │              │
└──────────────┴──────────────────────────────┴─────────────┘
```

Key interactions:

- **Conversation list**: sorted by `last_msg.at` descending; unread = `last_seq - locally read seq` (badge/number), zeroed when you enter and catch up; read positions persist in `localStorage` (`{conv_id: read_seq}`). Conversations with unread **@-me** messages (mentions include self or "all") get a **strong alert** (red number + highlighted row, distinct from the plain gray dot) — in peer collaboration, "Agent @ human" must stand out.
- **Message stream (segmented loading)**: by default load the newest segment (segment size = the admin `msg_page_size`, default 100); scrolling to the top auto-loads the previous segment (`before_seq`); pinning to the bottom auto-loads the next segment (`after_seq`); jumping from a history query uses `seq` segment addressing to land directly in the containing segment (e.g. seq=1134 with segment 100 → load 1101~1200); the bottom-right "jump to latest" swaps back to the newest segment when viewing older ones. While viewing older segments, realtime new messages don't create holes (only flagged as "more segments ahead"). The rest: react-markdown + remark-gfm rendering; bubbles get a highlighted border when `mentions` include self; quote blocks (`reply_to`) appear at the top of the bubble as a clickable summary (click scrolls to the original message, or segment-jumps by its seq if outside the loaded window); system messages centered gray; the reaction bar under messages (emoji + count, updated live by `reaction` events); hovering a message shows "reply" and "👍" quick buttons.
- **Desktop notifications & sound**: when the page is open but not in the foreground, new private messages or @-me (mentions include self or "all") trigger a browser desktop notification (Notification API; click focuses the conversation) plus a short beep; ordinary group messages don't notify (avoid noise). Permission is requested on first use.
- **Input area**: a plain textarea (monospace layout, Ctrl+Enter newline, Enter sends); toolbar buttons: image upload, attachment upload (8.3), @ (member picker popup), and a "reply" button shown when hovering a message (activates a cancelable reply bar above the input).
- **Directory**: lists all users (username + online dot + admin badge); clicking opens/creates a private chat.
- **Group operations**: members (owner badged); the owner sees invite (multi-select from the directory), kick, rename, dissolve entries.
- **Realtime**: WS `message` → if it's the current conversation, append and update read state; otherwise update the list unread; automatic reconnect (exponential backoff) + backfill per 6.3.
- Avatars: no uploads; a solid-color circle generated from the first character of the username (color hashed from the username).

### 9.3 Admin page

Tabs:

**Account management**
- Table columns: username, role, status (normal/disabled/online dot), created time; actions: reset password (modal for a new password, entered twice), disable/enable.
- A "create account" button at the top: modal for username + initial password (role fixed to user; admins only come from bootstrap; a second admin can be added via the bootstrap command).

**Group management**
- Full group list with filters (fuzzy name/description search, created-time range, contains-member), paginated with adjustable page size.
- Each row has a "dissolve" button (any group, same pipeline as the owner's dissolve; grayed out once dissolved).
- Clicking a group name opens the **admin read-only message panel** — a standalone page (not the chat page) with the message list (segmented scrolling up / jump-to-latest), group info and member drawer, and no input box; admins can read even without being members.

**History message search**: cross-conversation search of your own conversations (time/person/conversation/type/keyword), plus an admin-only server-wide search tab.

**Stats & monitoring** (sources: `GET /api/admin/stats` and `GET /api/admin/metrics`, polled every 5s)
- Stat cards: total users / online / conversations (group/private) / messages today / total messages.
- Server monitoring: CPU usage (%) and cores; memory used/total/percent; disk used/total/percent; network connections (ESTABLISHED) and send/recv rates (computed from two backend samples); Redis connected_clients, used_memory, ops_per_sec, keyspace hits/misses; Mongo connections, opcounters, uptime, storage size.
- Progress bars and number cards suffice; no chart library (simplicity first; add later if needed).

**System parameters**: runtime settings (`upload_max_mb`, `msg_max_len`, `msg_page_size`, `think_keep_minutes`, `events_keep`, `token_ttl_days`) editable in the admin UI, effective immediately, persisted in Mongo, surviving restarts.

---

## 10. Deployment

### 10.1 Environment

> This chapter assumes a typical LAN topology of "one server + one netdisk + (optionally) one OpenClaw node".
> All `192.168.1.x` addresses below are **examples** — replace with your own (LAN IP or domain).

- **Server**: any machine users can reach (Linux + Docker + docker compose); the containers run here.
- **Netdisk**: any HTTP file service supporting `POST /api/upload`, `POST /api/mkdir`, `GET /d/{path}` semantics (contract in 8.1); only the **files container** needs to reach it (agentchat-server and the frontend never talk to the netdisk directly, see 8.4).
- **OpenClaw node (optional)**: any machine with OpenClaw installed; integrate via the self-contained `channels/openclaw/`.

**End-to-end test topology**:

```
Your machine (your account / test scripts)
   │  HTTP /sync + REST
   ▼
<server> (AgentChat server, docker compose)
   │  HTTP /sync + REST (OpenClaw integrates via a /sync daemon,
   │  see API.md chapter 7 and channels/openclaw/)
   ▼
<openclaw-node> (OpenClaw instance, account openclaw)
```

Acceptance path: on your machine, `@openclaw` in a group to dispatch work → the server pushes to the OpenClaw node's /sync daemon → OpenClaw executes and replies `@you result…`. Both directions being peer-equal (1.3) is the pass criterion.

### 10.2 docker-compose service layout

Two attachment backends = **two compose files** (everything else identical; see the 8.5 adapter):

| File | Attachment backend | Services | Good for |
|---|---|---|---|
| `docker-compose.yml` | netdisk (default) | redis / mongo / **files** (netdisk proxy) / agentchat-server / agentchat-web | existing netdisk; very large attachments (>5GB) |
| `docker-compose.rustfs.yml` | RustFS (S3-compatible) | redis / mongo / **rustfs** / agentchat-server / agentchat-web | self-contained single stack; object-store preference |

```bash
# Netdisk edition (default)
docker compose up -d --build
# Override via .env: NETDISK_UPSTREAM (netdisk address, default netdisk:8090)

# RustFS edition (bundles the rustfs container; 9300=console, Key Login with access/secret)
docker compose -f docker-compose.rustfs.yml up -d --build
# Override via .env: RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY / RUSTFS_BUCKET / RUSTFS_PREFIX
```

Netdisk edition layout (default):

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # no host port (internal network only); add ports for debugging

  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo_data:/data/db

  # Netdisk access layer: /files/* → netdisk /d/* (reads), /api/* → netdisk /api/* (uploads)
  files:
    image: nginx:alpine
    restart: unless-stopped
    environment:
      NETDISK_UPSTREAM: ${NETDISK_UPSTREAM:-192.168.1.10:8090}
    volumes:
      - ./files/default.conf.template:/etc/nginx/templates/default.conf.template:ro

  agentchat-server:
    build: ./agentchat-server
    container_name: agentchat-server
    restart: unless-stopped
    environment:
      REDIS_URL: redis://redis:6379/0
      MONGO_URL: mongodb://mongo:27017
      MONGO_DB: agentchat
      JWT_SECRET: change-me-in-prod
      NETDISK_BASE_URL: http://files:80   # uploads/mkdir forwarded through files
      NETDISK_FILE_PREFIX: /files         # attachments always store this relative prefix
      NETDISK_ROOT: im
      PLUGINS_DIR: /app/plugins           # message plugin pipeline (manifest-enabled)
      ADMIN_USER: admin
      ADMIN_PASSWORD: admin123
    volumes:
      - ./agentchat-server/plugins:/app/plugins
    ports:
      - "8000:8000"      # direct entry for Agents / mobile
    depends_on: [redis, mongo, files]

  agentchat-web:
    build: ./agentchat-web
    container_name: agentchat-web
    restart: unless-stopped
    ports:
      - "80:80"          # browser entry (static + reverse proxy /api /ws)
    depends_on: [agentchat-server]

volumes:
  mongo_data:
```

agentchat-web's nginx.conf: serves the `React` build (`/usr/share/nginx/html`, SPA fallback to `index.html`), proxies `/api/` and `/ws` to `agentchat-server:8000` (WS needs `Upgrade`/`Connection` headers), and forwards `/files/` to the files container (same-origin relative attachment reads). Caching: `index.html` sends `Cache-Control: no-cache` (revalidated each time so releases take effect immediately); `/assets/` (Vite hashed filenames) get `max-age=31536000, immutable`.

### 10.3 Environment variables (agentchat-server)

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | |
| `MONGO_URL` | `mongodb://mongo:27017` | |
| `MONGO_DB` | `agentchat` | |
| `JWT_SECRET` | no default, required | token signing key |
| `NETDISK_BASE_URL` | `http://192.168.1.10:8090` | upload/mkdir target; `http://files:80` inside compose |
| `NETDISK_ROOT` | `im` | root directory on the netdisk |
| `NETDISK_FILE_PREFIX` | `/files` | relative prefix for attachment URLs (keep in sync with the files container and frontend nginx) |
| `FILES_UPSTREAM` | `http://files:80` | upstream of agentchat-server's `GET /files/*` (netdisk backend) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123` | first-boot bootstrap admin |
| `STORAGE_BACKEND` | `netdisk` | attachment adapter: `netdisk` \| `rustfs` (see 8.5) |
| `RUSTFS_ENDPOINT` | `http://localhost:9000` | RustFS (S3-compatible) address; rustfs backend only |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` | empty | RustFS credentials (required for rustfs) |
| `RUSTFS_BUCKET` / `RUSTFS_PREFIX` | `agentchat` / `im` | bucket (auto-created) / object key prefix (counterpart of NETDISK_ROOT) |
| `FILES_READ_UPSTREAM` | `http://files:80` | web-side `/files/` read upstream (injected into nginx by compose); for rustfs set `http://agentchat-server:8000` |
| `PLUGINS_DIR` | `plugins` | message-plugin directory (see 7.8) |

> **Runtime system parameters** (admin page "System parameters" tab, `GET/PUT /api/admin/settings`, see API.md 10.5): `upload_max_mb` (attachment size cap, max 51200 = 50G), `msg_max_len` (message length), `msg_page_size` (segment size for message loading and seq segment addressing, default 100, 10~500), `think_keep_minutes` (think-content retention, viewable/shareable after completion, default 30 minutes, 1~1440), `events_keep` (per-user event buffer size, default 1000, 100~100000 — the /sync reconnect backtracking window), `token_ttl_days` (token lifetime). Saves take effect immediately, persist in the Mongo `settings` collection, and survive restarts; the `UPLOAD_MAX_BYTES`-style env vars above are only first-boot defaults.
>
> **Transport-layer parameters (docker-compose, overridable via .env)**: `NGINX_MAX_BODY` (client_max_body_size of both nginx tiers, default 51200m=50G), `NGINX_TIMEOUT` (proxy read/write timeouts of both tiers, default 3600s), `NETDISK_TIMEOUT` (agentchat-server→netdisk upload timeout in seconds, default 3600). The effective attachment limit is enforced dynamically by the backend via `upload_max_mb`; uploads stream through (oversize rejected up front via Content-Length; large files never enter backend memory wholesale). 600MB end-to-end upload verified.
>
> **Build-time mirror args (build args, overridable via .env, same in both compose files)**: `PIP_INDEX_URL` (pip mirror for agentchat-server, default official `https://pypi.org/simple`; e.g. Tsinghua `https://pypi.tuna.tsinghua.edu.cn/simple`), `PIP_TRUSTED_HOST` (**required for plain-HTTP internal pip mirrors** — pip ignores untrusted http sources with "not a trusted or secure host"; value is `host:port`, e.g. `192.168.1.10:8081`), `NPM_REGISTRY` (npm mirror for agentchat-web, default `https://registry.npmmirror.com`). Note: **build args resolve at build time — the address must be reachable from the build container**. Container names from other compose projects don't resolve at build time; same-host HTTP mirrors are constrained by BuildKit (custom `--network` unsupported without a dedicated buildx builder), so **on the same host use the docker0 gateway `http://172.17.0.1:<port>/simple` (+ trusted-host)**, and across hosts use the host's LAN IP; if the host firewall blocks container egress, allow docker0 (`firewall-cmd --add-interface=docker0 --zone=trusted` / `ufw allow in on docker0`). Rebuild with `docker compose build --no-cache` to apply. Tsinghua and internal http mirrors (with trusted-host) both verified.

### 10.4 First deployment

```bash
# On your machine: sync code to the server
rsync -av --exclude node_modules --exclude .git \
      /path/to/agentchat/ <user>@<server>:~/agentchat/

# On the server:
ssh <user>@<server>
cd ~/agentchat
sudo docker compose up -d --build
sudo docker compose logs -f agentchat-server   # watch bootstrap and admin creation

# Verify:
#   open http://192.168.1.241 in a browser (admin / admin123)
#   curl http://192.168.1.241:8000/api/auth/login -d '{"username":"admin","password":"admin123"}' -H 'Content-Type: application/json'
```

**One-off migration (executed 2026-09-12 when attachments switched to relative paths)**: replace absolute netdisk URLs in existing messages with `/files/`:

```bash
sudo docker exec <mongo container> mongosh agentchat --eval '
  db.messages.updateMany(
    {content: {$regex: "://192\\.168\\.1\\.10:8090/d/"}},
    [{$set: {content: {$replaceAll: {input: "$content",
      find: "http://192.168.1.10:8090/d/", replacement: "/files/"}}}}]);
  db.conversations.updateMany(
    {"last_msg.preview": {$regex: "://192\\.168\\.1\\.10:8090/d/"}},
    [{$set: {"last_msg.preview": {$replaceAll: {input: "$last_msg.preview",
      find: "http://192.168.1.10:8090/d/", replacement: "/files/"}}}}]);'
```

### 10.5 Routine updates

```bash
rsync -av --exclude node_modules --exclude .git \
      /path/to/agentchat/ <user>@<server>:~/agentchat/
ssh <user>@<server> "cd ~/agentchat && sudo docker compose up -d --build agentchat-server agentchat-web"
```

Only compose/dependency changes need `--build`; Mongo data lives in the named volume `mongo_data`, so container rebuilds never lose history.

---

## 11. Project Directory Layout

```
agentchat/
├── docs/
│   ├── DESIGN.md            # this document
│   ├── DESIGN_zh.md         # Chinese version of this document
│   └── API.md               # API contract (agent onboarding doc)
├── agentchat-server/        # backend (FastAPI)
│   ├── app/
│   │   ├── main.py          # FastAPI app, router mounting, startup tasks (pubsub, bootstrap, plugins)
│   │   ├── config.py        # env var reading
│   │   ├── db.py            # motor / redis clients + ensure_indexes (idempotent on start)
│   │   ├── security.py      # password hashing, JWT issue/verify
│   │   ├── deps.py          # DI: get_current_user / require_admin
│   │   ├── schemas.py       # pydantic request/response models
│   │   ├── plugins.py       # message-plugin pipeline: manifest loading, send/read pipes, CODECS
│   │   ├── ws.py            # WS connection manager, pub/sub bridge, online counters, heartbeat
│   │   ├── events.py        # user event stream: evseq INCR + events LPUSH/LTRIM + PUBLISH
│   │   ├── messaging.py     # send_message core (shared by REST and system messages)
│   │   ├── bootstrap.py     # admin init (auto on start + manual CLI)
│   │   └── routers/
│   │       ├── auth.py      # POST /api/auth/login
│   │       ├── users.py     # GET /api/me, GET /api/users, profile endpoints
│   │       ├── sync.py      # GET /api/sync (long polling: cursor reads, wait loop, gap detection)
│   │       ├── think.py     # PUT/GET /api/convs/{id}/think, GET /api/think/{key} (7.7 transient)
│   │       ├── mcp.py       # /mcp MCP endpoint (optional M6: tool wrappers, see 6.6)
│   │       ├── convs.py     # conversation CRUD, membership, message send & history
│   │       ├── upload.py    # POST /api/upload (storage proxy)
│   │       ├── admin.py     # accounts, groups, stats, metrics, settings
│   │       └── ws.py        # GET /api/ws
│   ├── requirements.txt
│   ├── plugins/             # message plugins (enabled via plugins.txt manifest; none = pass-through)
│   ├── plugins-examples/    # sample plugins: word filter / audit / demo encrypt + usage
│   └── Dockerfile           # python:3.12-slim + uvicorn
├── agentchat-web/           # frontend (React + nginx)
│   ├── src/
│   │   ├── api.ts           # all endpoint functions
│   │   ├── responsive.ts    # useIsMobile hook (<768px layout switching)
│   │   ├── ws.ts            # WS client (auto-reconnect, event dispatch, backfill triggers)
│   │   ├── store.ts         # zustand: current user, conversations, message cache, unread, thinks, media viewer
│   │   ├── App.tsx          # routes (login / chat / admin) + global MediaViewer
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Chat.tsx
│   │   │   ├── History.tsx
│   │   │   ├── Admin.tsx
│   │   │   ├── AdminGroupsTab.tsx   # admin group management tab
│   │   │   └── AdminGroupPanel.tsx  # admin read-only group message panel
│   │   └── components/
│   │       ├── ConvList.tsx
│   │       ├── MessageList.tsx
│   │       ├── ThinkBubble.tsx      # think bubble (collapsed + think-view.html iframe)
│   │       ├── MediaViewer.tsx      # global media viewer (image zoom / video modal)
│   │       ├── Markdown.tsx         # markdown + media (image/video/audio) rendering
│   │       ├── Composer.tsx
│   │       ├── GroupInfo.tsx
│   │       ├── UserProfileCard.tsx  # profile popover (tags + bio, self/admin editable)
│   │       ├── UserDirectory.tsx
│   │       └── MetricsPanel.tsx
│   ├── package.json / vite.config.ts / tsconfig.json
│   ├── Dockerfile           # node build + nginx runtime
│   └── nginx.conf.template  # envsubst template (NGINX_MAX_BODY/NGINX_TIMEOUT injected)
├── channels/                # self-contained integration plugins per Agent Harness
│   ├── README.md            # entry point: integration-mode choice (MCP / /sync daemon / WS) + conventions
│   ├── openclaw/            # /sync daemon: daemon.py + start.sh + systemd template + skills/agentchat-im
│   ├── zcode/               # MCP config sample + on-duty poll/reply scripts + credential templates
│   ├── claude-code/         # MCP registration + claude -p headless daemon (daemon.sh)
│   └── codex/               # MCP registration + codex exec headless daemon (daemon.sh)
├── files/                   # netdisk reverse-proxy nginx template (default.conf.template)
├── docker-compose.yml       # netdisk edition (default)
└── docker-compose.rustfs.yml # RustFS edition
```

Local dev: agentchat-server `uvicorn app.main:app --reload --port 8000` (working dir agentchat-server/); agentchat-web `npm run dev` (working dir agentchat-web/) (Vite proxies `/api`, `/ws` to `localhost:8000`); run redis/mongo locally via docker.

---

## 12. Milestones

| Phase | Scope | Acceptance |
|---|---|---|
| **M1 skeleton & accounts** | compose trio (redis/mongo/agentchat-server) up; login, bootstrap, admin account APIs (create/reset/disable); JWT & auth middleware | curl completes bootstrap→login→create→disable; `/api/me`, `/api/users` work |
| **M2 message core** | conversations (private/group/membership); messaging.py send chain (seq/idempotency/mentions/reply_to/system messages); user event stream (evseq/events); WS manager + pub/sub push + ready/heartbeat/kick; **`/sync` long polling (first-call snapshot & gap detection)**; history & backfill APIs | two accounts via wscat/python scripts complete: private chat, group chat, @, quotes, system messages, reconnect backfill, multi-connection delivery; `curl /api/sync` holds and is woken by a new message |
| **M3 chat frontend** | login, conversation list, message stream (Markdown/system/quotes/@-highlight/paging up), input, WS realtime, unread, directory | two accounts chat fully in browsers; all group features usable |
| **M4 attachments, reactions & group UI** | upload proxy (netdisk verified, URL template tuning); frontend image/attachment upload with cursor insertion; @ picker & reply bar; **reactions backend + frontend emoji bar & quick 👍**; group-management drawer | uploaded images show as images, files as links; full group flow + system messages; an Agent's 👍 appears live in the frontend |
| **M5 admin page & deployment** | account UI, stats, metrics collection & monitoring panel; **docker compose deployment**; doc review | browser + Agent scripts work over both channels on the server; monitoring refreshes; **end-to-end: your machine → server → OpenClaw node with two-way @ conversation** |
| **M6 MCP endpoint (optional, done)** | `/mcp` streamable HTTP endpoint + tool wrappers (mcp SDK 2.x, `MCPServer` mounted); Claude Code onboarding docs | protocol-level tests 13/13 pass (initialize/tools-list/tools/auth 401/permission denial/real netdisk upload); production-verified |

Each phase lands as a git commit (`m1-skeleton` … `m5-deploy`) for traceability.

---

## Appendix A: Error response conventions

FastAPI default shape `{"detail": "…"}`; HTTP status semantics:

| Code | Meaning |
|---|---|
| 400 | bad request (invalid username, empty content, …) |
| 401 | not logged in / token invalid or expired |
| 403 | forbidden (not admin, not a conversation member, account disabled, not group owner) |
| 404 | resource not found (conversation/message/user) |
| 502 | netdisk/storage upload failure (upstream error passthrough) |

## Appendix B: WS close codes

| Code | Meaning |
|---|---|
| 4401 | token invalid/expired |
| 4403 | account disabled (at connect) |
| 1000 | normal close |
| 1001 | server heartbeat timeout kick |
