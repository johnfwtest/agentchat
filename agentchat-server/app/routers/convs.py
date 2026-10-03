import re

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query

from app import messaging, settings
from app.db import convs_col, msgs_col, redis, users_col
from app.deps import get_current_user
from app.messaging import serialize_msg
from app.schemas import (AddMemberIn, CreateGroupIn, CreatePrivateIn, SendMessageIn,
                         UpdateGroupIn, now_iso)

router = APIRouter(prefix="/api")
CONV_ID_RE = re.compile(r"^(private:[a-z0-9_-]{2,32}:[a-z0-9_-]{2,32}|[a-f0-9]{24})$")

# 系统消息双语模板：按发起人（操作者）登录时上报的语言生成；无记录默认 en。
LANG_KEY = "ac:user:{u}:lang"
SYS_MSGS = {
    "zh": {
        "create": "{a} 创建了群聊「{name}」",
        "invite": "{a} 邀请 {u} 加入群聊",
        "remove": "{a} 将 {u} 移出了群聊",
        "leave": "{u} 退出了群聊",
        "rename": "{a} 将群名修改为「{name}」",
        "dissolve": "{a} 解散了群聊",
        "admin_dissolve": "admin 解散了群聊（管理员操作）",
    },
    "en": {
        "create": '{a} created the group "{name}"',
        "invite": "{a} invited {u} to the group",
        "remove": "{a} removed {u} from the group",
        "leave": "{u} left the group",
        "rename": '{a} renamed the group to "{name}"',
        "dissolve": "{a} dissolved the group",
        "admin_dissolve": "admin dissolved the group (admin action)",
    },
}


async def sys_msg(actor: str, key: str, **kw) -> str:
    """按发起人语言渲染系统消息模板（Redis 无记录时默认 en）。"""
    lang = await redis.get(LANG_KEY.format(u=actor))
    lang = lang.decode() if isinstance(lang, bytes) else lang
    tpl = SYS_MSGS.get(lang) or SYS_MSGS["en"]
    return tpl[key].format(a=actor, **kw)


def conv_out(conv: dict) -> dict:
    return {
        "id": str(conv["_id"]),
        "type": conv["type"],
        "name": conv.get("name"),
        "desc": conv.get("desc") or "",
        "members": conv["members"],
        "owner": conv.get("owner"),
        "last_seq": conv.get("last_seq") or 0,
        "last_msg": conv.get("last_msg"),
        "created_at": conv.get("created_at"),
    }


async def get_conv_or_404(conv_id: str) -> dict:
    if not CONV_ID_RE.match(conv_id):
        raise HTTPException(404, "会话不存在")
    conv = await convs_col.find_one({"_id": conv_id})
    if not conv:
        raise HTTPException(404, "会话不存在")
    return conv


@router.get("/convs")
async def list_convs(user: dict = Depends(get_current_user)):
    convs = []
    async for c in convs_col.find({"members": user["_id"]}).sort("last_msg.at", -1):
        convs.append(conv_out(c))
    return {"conversations": convs}


@router.post("/convs/private", status_code=201)
async def create_private(body: CreatePrivateIn, user: dict = Depends(get_current_user)):
    me, peer = user["_id"], body.peer
    if peer == me:
        raise HTTPException(400, "不能和自己创建私聊")
    if not await users_col.find_one({"_id": peer}):
        raise HTTPException(404, "peer 不存在")
    conv_id = f"private:{min(me, peer)}:{max(me, peer)}"
    conv = await convs_col.find_one_and_update(
        {"_id": conv_id},
        {"$setOnInsert": {"type": "private", "name": None, "owner": None,
                          "members": [me, peer], "last_seq": 0, "last_msg": None,
                          "created_at": now_iso()}},
        upsert=True, return_document=True)
    return conv_out(conv)


@router.post("/convs/group", status_code=201)
async def create_group(body: CreateGroupIn, user: dict = Depends(get_current_user)):
    me = user["_id"]
    members = {m for m in body.members if m != me}
    for m in members:
        if not await users_col.find_one({"_id": m}):
            raise HTTPException(404, f"用户 {m} 不存在")
    members.add(me)
    conv = {
        "_id": str(ObjectId()),
        "type": "group", "name": body.name, "desc": (body.desc or "").strip(),
        "owner": me,
        "members": sorted(members), "last_seq": 0, "last_msg": None,
        "created_at": now_iso(),
    }
    await convs_col.insert_one(conv)
    await messaging.send_system(conv, me, await sys_msg(me, "create", name=body.name))
    fresh = await convs_col.find_one({"_id": conv["_id"]})
    return conv_out(fresh)


@router.get("/convs/{conv_id}")
async def get_conv(conv_id: str, user: dict = Depends(get_current_user)):
    conv = await get_conv_or_404(conv_id)
    if user["_id"] not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    return conv_out(conv)


@router.post("/convs/{conv_id}/members", status_code=201)
async def add_member(conv_id: str, body: AddMemberIn,
                     user: dict = Depends(get_current_user)):
    me = user["_id"]
    conv = await get_conv_or_404(conv_id)
    if conv["type"] != "group":
        raise HTTPException(400, "仅群聊支持成员管理")
    if me not in conv["members"]:        # 2026-09-12 起普通成员也可拉人
        raise HTTPException(403, "不是会话成员")
    target = body.username
    if not await users_col.find_one({"_id": target}):
        raise HTTPException(404, f"用户 {target} 不存在")
    if target in conv["members"]:
        raise HTTPException(400, "已在群内")
    await convs_col.update_one({"_id": conv_id}, {"$addToSet": {"members": target}})
    conv = await get_conv_or_404(conv_id)
    await messaging.send_system(conv, me, await sys_msg(me, "invite", u=target))
    return conv_out(await convs_col.find_one({"_id": conv_id}))


@router.delete("/convs/{conv_id}/members/{username}")
async def remove_member(conv_id: str, username: str,
                        user: dict = Depends(get_current_user)):
    me = user["_id"]
    conv = await get_conv_or_404(conv_id)
    if conv["type"] != "group" or conv.get("owner") != me:
        raise HTTPException(403, "仅群主可以移出成员")
    if username == me:
        raise HTTPException(400, "群主不能移出自己，请使用解散")
    if username not in conv["members"]:
        raise HTTPException(404, "该用户不在群内")
    await convs_col.update_one({"_id": conv_id}, {"$pull": {"members": username}})
    conv = await get_conv_or_404(conv_id)
    await messaging.send_system(conv, me, await sys_msg(me, "remove", u=username))
    return conv_out(await convs_col.find_one({"_id": conv_id}))


@router.patch("/convs/{conv_id}")
async def update_group(conv_id: str, body: UpdateGroupIn,
                       user: dict = Depends(get_current_user)):
    """改群名 / 群描述（均仅群主；至少传一项）。改名发系统消息，改描述静默。"""
    me = user["_id"]
    conv = await get_conv_or_404(conv_id)
    if conv["type"] != "group" or conv.get("owner") != me:
        raise HTTPException(403, "仅群主可以修改群资料")
    update: dict = {}
    if body.name is not None:
        update["name"] = body.name
    if body.desc is not None:
        update["desc"] = body.desc.strip()
    if not update:
        raise HTTPException(400, "无更新字段（name / desc 至少一项）")
    await convs_col.update_one({"_id": conv_id}, {"$set": update})
    if "name" in update:
        conv = await get_conv_or_404(conv_id)
        await messaging.send_system(conv, me, await sys_msg(me, "rename", name=body.name))
    return conv_out(await convs_col.find_one({"_id": conv_id}))


@router.post("/convs/{conv_id}/leave")
async def leave_group(conv_id: str, user: dict = Depends(get_current_user)):
    me = user["_id"]
    conv = await get_conv_or_404(conv_id)
    if conv["type"] != "group":
        raise HTTPException(400, "私聊不支持退出")
    if conv.get("owner") == me:
        raise HTTPException(403, "群主请使用解散")
    if me not in conv["members"]:
        raise HTTPException(404, "不在群内")
    await convs_col.update_one({"_id": conv_id}, {"$pull": {"members": me}})
    conv = await get_conv_or_404(conv_id)
    await messaging.send_system(conv, me, await sys_msg(me, "leave", u=me))
    return {"ok": True}


@router.post("/convs/{conv_id}/dissolve")
async def dissolve_group(conv_id: str, user: dict = Depends(get_current_user)):
    me = user["_id"]
    conv = await get_conv_or_404(conv_id)
    if conv["type"] != "group" or conv.get("owner") != me:
        raise HTTPException(403, "仅群主可以解散群聊")
    await messaging.send_system(conv, me, await sys_msg(me, "dissolve"))
    await convs_col.delete_one({"_id": conv_id})
    return {"ok": True}


@router.post("/convs/{conv_id}/messages")
async def send_message(conv_id: str, body: SendMessageIn,
                       user: dict = Depends(get_current_user)):
    conv = await get_conv_or_404(conv_id)
    if user["_id"] not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    from app.plugins import check_codec
    check_codec(body.codec)
    msg, created = await messaging.send_message(
        conv, user["_id"], body.content,
        reply_to_seq=body.reply_to_seq, client_msg_id=body.client_msg_id,
        codec=body.codec)
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=201 if created else 200, content=msg)


async def query_messages(conv_id: str, conv: dict, seq: int = -1, after_seq: int = -1,
                         before_seq: int = -1, limit: int = 0) -> dict:
    """消息窗口查询（REST 与 MCP 共用）。三种寻址（互斥，优先级 seq > after_seq > 最新段）：

      seq>0        → 该消息所在的**对齐分段**：段大小 = 管理页 msg_page_size（默认 100），
                     如 seq=1134 → 返回 1101~1200；响应带 seg_start/seg_end
      after_seq>=0 → 其后 limit 条（升序；增量补拉/向后翻段）
      其他         → 最新 limit 条（before_seq>0 时向前翻段）

    limit 缺省(0) = 一整段（msg_page_size），上限 1000。响应统一带：
    has_more（兼容旧义：after 模式=后面还有，其余=前面还有）、
    has_more_before / has_more_after（窗口化客户端用）。
    """
    last = conv.get("last_seq") or 0
    if seq > 0:
        size = settings.current("msg_page_size")
        start = (seq - 1) // size * size + 1
        end = min(start + size - 1, last)
        cursor = msgs_col.find({"conv_id": conv_id,
                                "seq": {"$gte": start, "$lte": end}}).sort("seq", 1)
        msgs = [serialize_msg(m) async for m in cursor]
        return {"messages": msgs, "has_more": start > 1,
                "has_more_before": start > 1, "has_more_after": end < last,
                "seg_start": start, "seg_end": end}
    limit = max(1, min(limit or settings.current("msg_page_size"), 1000))
    query = {"conv_id": conv_id}
    if after_seq >= 0:
        query["seq"] = {"$gt": after_seq}
        cursor = msgs_col.find(query).sort("seq", 1).limit(limit)
        msgs = [serialize_msg(m) async for m in cursor]
        has_more_after = len(msgs) == limit and await msgs_col.find_one(
            {"conv_id": conv_id, "seq": {"$gt": msgs[-1]["seq"]}}) is not None
        has_more_before = (msgs[0]["seq"] > 1) if msgs else (after_seq > 0)
        return {"messages": msgs, "has_more": has_more_after,
                "has_more_before": has_more_before, "has_more_after": has_more_after}
    if before_seq > 0:
        query["seq"] = {"$lt": before_seq}
    cursor = msgs_col.find(query).sort("seq", -1).limit(limit)
    msgs = [serialize_msg(m) async for m in cursor]
    msgs.reverse()
    has_more_before = len(msgs) == limit and msgs[0]["seq"] > 1
    has_more_after = (msgs[-1]["seq"] < last) if msgs else False
    return {"messages": msgs, "has_more": has_more_before,
            "has_more_before": has_more_before, "has_more_after": has_more_after}


@router.get("/convs/{conv_id}/messages")
async def get_messages(conv_id: str, seq: int = -1, after_seq: int = -1,
                       before_seq: int = -1, limit: int = 0,
                       user: dict = Depends(get_current_user)):
    conv = await get_conv_or_404(conv_id)
    if user["_id"] not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    return await query_messages(conv_id, conv, seq, after_seq, before_seq, limit)


# ---------- reactions ----------

async def _get_msg_for_member(message_id: str, username: str) -> dict:
    if not re.match(r"^[a-f0-9]{24}$", message_id):
        raise HTTPException(404, "消息不存在")
    msg = await msgs_col.find_one({"_id": ObjectId(message_id)})
    if not msg:
        raise HTTPException(404, "消息不存在")
    conv = await convs_col.find_one({"_id": msg["conv_id"]})
    if not conv or username not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    if msg["type"] == "system":
        raise HTTPException(400, "系统消息不能添加表情回应")
    return msg


async def _broadcast_reaction(message_id, conv_id: str, emoji: str, action: str,
                              actor: str, reactions: list[dict]):
    conv = await convs_col.find_one({"_id": conv_id})
    if not conv:
        return
    event = {"type": "reaction", "reaction": {
        "message_id": str(message_id), "conv_id": conv_id,
        "emoji": emoji, "action": action, "username": actor,
        "reactions": reactions}}
    from app import events as events_mod
    for member in set(conv["members"]):
        await events_mod.publish_event(member, event)


def _apply_reaction(reactions: list[dict], emoji: str, username: str, add: bool) -> list[dict]:
    out = []
    found = False
    for r in reactions or []:
        if r.get("emoji") == emoji:
            found = True
            users = [u for u in r.get("users", []) if u != username]
            if add:
                users.append(username)
            if users:
                out.append({"emoji": emoji, "users": users})
        else:
            out.append(r)
    if add and not found:
        out.append({"emoji": emoji, "users": [username]})
    return out


@router.post("/messages/{message_id}/reactions")
async def add_reaction(message_id: str, body: dict,
                       user: dict = Depends(get_current_user)):
    emoji = (body or {}).get("emoji", "").strip()
    if not emoji or len(emoji) > 16:
        raise HTTPException(400, "emoji 无效")
    me = user["_id"]
    msg = await _get_msg_for_member(message_id, me)
    new_reactions = _apply_reaction(msg.get("reactions"), emoji, me, add=True)
    await msgs_col.update_one({"_id": msg["_id"]}, {"$set": {"reactions": new_reactions}})
    await _broadcast_reaction(msg["_id"], msg["conv_id"], emoji, "add", me, new_reactions)
    return {"ok": True, "reactions": new_reactions}


@router.delete("/messages/{message_id}/reactions/{emoji}")
async def remove_reaction(message_id: str, emoji: str,
                          user: dict = Depends(get_current_user)):
    from urllib.parse import unquote
    emoji = unquote(emoji).strip()
    me = user["_id"]
    msg = await _get_msg_for_member(message_id, me)
    new_reactions = _apply_reaction(msg.get("reactions"), emoji, me, add=False)
    await msgs_col.update_one({"_id": msg["_id"]}, {"$set": {"reactions": new_reactions}})
    await _broadcast_reaction(msg["_id"], msg["conv_id"], emoji, "remove", me, new_reactions)
    return {"ok": True, "reactions": new_reactions}


@router.get("/messages/search")
async def search_messages(
    sender: str | None = Query(None),
    conv_id: str | None = Query(None),
    type: str | None = Query(None),
    start: str | None = Query(None),     # YYYY-MM-DD 或完整 ISO 时间
    end: str | None = Query(None),
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """历史消息查询：只能检索自己是成员的会话（不越权看他人私聊）。"""
    me = user["_id"]
    member_ids = [c["_id"] async for c in
                  convs_col.find({"members": me}, {"_id": 1})]
    if conv_id and conv_id not in member_ids:
        raise HTTPException(403, "不是会话成员")
    query = {"conv_id": {"$in": member_ids}}
    query.update(messaging.build_search_query(
        sender=sender, conv_id=conv_id, type=type, start=start, end=end, q=q))
    return await messaging.search_messages(query, page, limit)
