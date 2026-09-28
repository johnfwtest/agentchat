"""消息发送核心：REST 发送、系统消息、reaction 通知共用此模块。"""
import re

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from app import events, settings
from app.db import convs_col, msgs_col, redis
from app.schemas import now_iso

MENTION_RE = re.compile(r"@([a-z0-9_-]{2,32})")
SEQ_KEY = "ac:conv:{cid}:seq"


def parse_mentions(content: str, members: list[str]) -> list[str]:
    found = {m for m in MENTION_RE.findall(content)}
    mentions = sorted(found & set(members))
    if "@all" in content:
        mentions.append("all")
    return mentions


def serialize_msg(doc: dict) -> dict:
    # 读取管道（逆序栈式还原）：全部读取出口（REST/MCP/WS//sync/搜索）的
    # 公共汇聚点，无插件时原样直通。conv 信息插件按需用（多数只用 content/codec）
    from app import plugins as plugins_mod
    content, codec = plugins_mod.read_pipe(
        None, doc, doc.get("content") or "", doc.get("codec") or 0)
    return {
        "id": str(doc["_id"]),
        "conv_id": doc["conv_id"],
        "seq": doc["seq"],
        "sender": doc["sender"],
        "type": doc["type"],
        "content": content,
        "codec": codec,
        "mentions": doc.get("mentions") or [],
        "reactions": doc.get("reactions") or [],
        "reply_to": doc.get("reply_to"),
        "client_msg_id": doc.get("client_msg_id"),
        "created_at": doc.get("created_at"),
    }


async def next_seq(conv_id: str) -> int:
    key = SEQ_KEY.format(cid=conv_id)
    if not await redis.exists(key):
        last = await msgs_col.find_one({"conv_id": conv_id}, sort=[("seq", -1)])
        await redis.set(key, last["seq"] if last else 0, nx=True)
    return await redis.incr(key)


async def get_conv(conv_id: str, username: str) -> dict:
    conv = await convs_col.find_one({"_id": conv_id})
    if not conv:
        raise HTTPException(404, "会话不存在")
    if username not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    return conv


async def send_message(
    conv: dict,
    sender: str,
    content: str,
    msg_type: str = "text",
    reply_to_seq: int | None = None,
    client_msg_id: str | None = None,
    codec: int = 0,
) -> tuple[dict, bool]:
    """返回 (消息, 是否新创建)。client_msg_id 幂等命中时返回已有消息且 created=False。"""
    conv_id = conv["_id"]

    # 幂等：同 client_msg_id 直接返回已有消息
    if client_msg_id:
        existed = await msgs_col.find_one({"conv_id": conv_id, "client_msg_id": client_msg_id})
        if existed:
            return serialize_msg(existed), False

    if msg_type == "text" and len(content) > settings.current("msg_max_len"):
        raise HTTPException(400, f"消息超过最大长度 {settings.current('msg_max_len')} 字符")

    # mentions 从入参原文解析（客户端自带 codec 时密文里无 @ 信息，合理为空；
    # 过滤改写不影响主流场景），随后内容进发送管道（清单顺序，仅用户 text）
    mentions = parse_mentions(content, conv["members"]) if msg_type == "text" else []
    from app import plugins as plugins_mod
    if msg_type == "text":
        content, codec = plugins_mod.send_pipe(conv, sender, content, codec)

    reply_to = None
    if reply_to_seq:
        src = await msgs_col.find_one({"conv_id": conv_id, "seq": reply_to_seq})
        if not src:
            raise HTTPException(404, "被引用的消息不存在")
        excerpt = re.sub(r"\s+", " ", src["content"])[:50]
        reply_to = {"seq": src["seq"], "sender": src["sender"], "excerpt": excerpt}

    doc = None
    for _ in range(3):  # (conv_id,seq) 唯一索引兜底并发，冲突则重取 seq
        seq = await next_seq(conv_id)
        doc = {
            "conv_id": conv_id,
            "seq": seq,
            "sender": sender,
            "type": msg_type,
            "content": content,
            "codec": codec,
            "mentions": mentions,
            "reactions": [],
            "reply_to": reply_to,
            "client_msg_id": client_msg_id,
            "created_at": now_iso(),
        }
        try:
            await msgs_col.insert_one(doc)
            break
        except DuplicateKeyError:
            doc = None
            # client_msg_id 唯一冲突（并发同键，如双 daemon 实例回复同一条
            # 触发消息）：幂等命中，回读已有消息返回，不算失败
            if client_msg_id:
                existed = await msgs_col.find_one(
                    {"conv_id": conv_id, "client_msg_id": client_msg_id})
                if existed:
                    return serialize_msg(existed), False
        except Exception:
            doc = None
    if doc is None:
        raise HTTPException(500, "消息写入失败，请重试")

    preview = (re.sub(r"\s+", " ", content)[:50]) if msg_type == "text" else content[:50]
    await convs_col.update_one(
        {"_id": conv_id},
        {
            "$max": {"last_seq": doc["seq"]},
            "$set": {"last_msg": {"seq": doc["seq"], "sender": sender,
                                  "preview": preview, "at": doc["created_at"]}},
        },
    )

    # 正式消息落库 = 该 sender 的 think 思考流结束：标记 done 并按
    # think_keep_minutes 保留（分享链接保留期内可回看，过期自清，见 7.7）。
    # 不广播——前端气泡本来就由下面的 message 事件自动清除。
    from app.routers.think import finish_think_on_message
    await finish_think_on_message(conv_id, sender)

    event = {"type": "message", "message": serialize_msg(doc)}
    for member in set(conv["members"]):
        await events.publish_event(member, event)

    return serialize_msg(doc), True


async def send_system(conv: dict, actor: str, text: str) -> dict:
    """系统消息：'xx 加入群聊' 等，sender 为触发者，占 seq、落库、走完整事件流。"""
    return await send_message(conv, sender=actor, content=text, msg_type="system")


# ---------- 历史消息查询（个人 /api/messages/search 与管理端共用） ----------
def build_search_query(*, sender: str | None = None, conv_id: str | None = None,
                       type: str | None = None, start: str | None = None,
                       end: str | None = None, q: str | None = None) -> dict:
    query: dict = {}
    # 搜索默认只覆盖明文（codec=0 及无字段的历史消息）——密文/其他形态 regex
    # 无意义，查询层直接排除（新注册的非 0 codec 自动被排除）
    query["$or"] = [{"codec": {"$exists": False}}, {"codec": 0}]
    if conv_id:
        query["conv_id"] = conv_id
    if sender:
        query["sender"] = sender
    if type in ("text", "system"):
        query["type"] = type
    if start:  # created_at 为 UTC ISO 字符串，字典序即时序
        query["created_at"] = {"$gte": f"{start}T00:00:00Z" if len(start) == 10 else start}
    if end:
        query.setdefault("created_at", {})["$lte"] = \
            f"{end}T23:59:59Z" if len(end) == 10 else end
    if q:
        query["content"] = {"$regex": re.escape(q), "$options": "i"}
    return query


async def search_messages(query: dict, page: int, limit: int) -> dict:
    # 会话范围查询强制走 (conv_id, created_at) 复合索引：$in 多键经 SORT_MERGE
    # 归并排序，无内存排序（32MB 上限风险）、limit 只碰所需索引项。
    # 带 sender 过滤时不 hint——planner 会选 (sender, created_at)，选择性更高。
    hint = None
    if "conv_id" in query and "sender" not in query:
        hint = {"conv_id": 1, "created_at": -1}
    total = await msgs_col.count_documents(
        query, hint=hint) if hint else await msgs_col.count_documents(query)
    cursor = msgs_col.find(query).sort("created_at", -1)
    if hint:
        cursor = cursor.hint(hint)
    cursor = cursor.skip((page - 1) * limit).limit(limit)
    return {"messages": [serialize_msg(m) async for m in cursor],
            "total": total, "page": page, "limit": limit}
