import re
import time
from datetime import datetime, timezone

import psutil
from fastapi import APIRouter, Depends, HTTPException, Query

from app import messaging, security, settings as runtime_settings
from app.db import convs_col, db, msgs_col, redis, users_col
from app.deps import require_admin
from app.routers.convs import conv_out
from app.schemas import CreateUserIn, UpdateSettingsIn, UpdateUserIn, now_iso
from app.ws import manager, online_count

router = APIRouter(prefix="/api/admin")
USERNAME_RE = re.compile(r"^[a-z0-9_-]{2,32}$")

_last_net: dict | None = None  # 上次网络采样（速率计算）


@router.post("/users", status_code=201)
async def create_user(body: CreateUserIn, _: dict = Depends(require_admin)):
    if not USERNAME_RE.match(body.username):
        raise HTTPException(400, "用户名须匹配 ^[a-z0-9_-]{2,32}$")
    if await users_col.find_one({"_id": body.username}):
        raise HTTPException(409, "用户名已存在")
    h, salt = security.hash_password(body.password)
    doc = {"_id": body.username, "username": body.username,
           "password_hash": h, "salt": salt, "role": "user",
           "disabled": False, "created_at": now_iso()}
    await users_col.insert_one(doc)
    return {"username": doc["username"], "role": "user", "disabled": False,
            "created_at": doc["created_at"]}


@router.patch("/users/{username}")
async def update_user(username: str, body: UpdateUserIn,
                      _: dict = Depends(require_admin)):
    user = await users_col.find_one({"_id": username})
    if not user:
        raise HTTPException(404, "用户不存在")
    update: dict = {}
    if body.password is not None:
        if not body.password:
            raise HTTPException(400, "密码不能为空")
        h, salt = security.hash_password(body.password)
        update.update({"password_hash": h, "salt": salt})
    if body.disabled is not None:
        update["disabled"] = body.disabled
    if not update:
        raise HTTPException(400, "无更新字段")
    await users_col.update_one({"_id": username}, {"$set": update})
    if body.disabled is True:
        await manager.kick_user(username)
    return {"username": username, "role": user["role"],
            "disabled": body.disabled if body.disabled is not None else bool(user.get("disabled")),
            "created_at": user.get("created_at")}


@router.get("/settings")
async def get_settings(_: dict = Depends(require_admin)):
    return runtime_settings.snapshot()


@router.put("/settings")
async def put_settings(body: UpdateSettingsIn, _: dict = Depends(require_admin)):
    return {"values": await runtime_settings.update(body.model_dump())}


@router.get("/convs")
async def admin_list_convs(_: dict = Depends(require_admin)):
    """全部会话（管理页全服历史查询的会话下拉用）。"""
    return {"conversations": [conv_out(c) async for c in
                              convs_col.find().sort("last_msg.at", -1)]}


@router.get("/messages/search")
async def admin_search_messages(
    sender: str | None = Query(None),
    conv_id: str | None = Query(None),
    recipient: str | None = Query(None),   # 接收人：私聊消息的接收方（群/系统消息无接收人）
    type: str | None = Query(None),
    start: str | None = Query(None),
    end: str | None = Query(None),
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=1000),
    _: dict = Depends(require_admin),
):
    """全服历史消息查询：不限会话成员资格（仅 admin）。

    接收人按消息语义推导：所在会话为私聊、本人是成员、且不是发送者
    （群消息/系统消息为广播、无单一接收人，指定接收人时自然排除）。"""
    query = messaging.build_search_query(
        sender=sender, conv_id=conv_id, type=type, start=start, end=end, q=q)

    if recipient:
        rids = [c["_id"] async for c in convs_col.find(
            {"type": "private", "members": recipient}, {"_id": 1})]
        if not rids:
            return {"messages": [], "total": 0, "page": page, "limit": limit}
        query["conv_id"] = {"$in": rids} if not conv_id else conv_id \
            if conv_id in rids else None
        if query.get("conv_id") is None:
            return {"messages": [], "total": 0, "page": page, "limit": limit}
        query.setdefault("$and", []).append({"sender": {"$ne": recipient}})
    return await messaging.search_messages(query, page, limit)


@router.get("/stats")
async def stats(_: dict = Depends(require_admin)):
    total = await users_col.count_documents({})
    disabled = await users_col.count_documents({"disabled": True})
    online = 0
    async for u in users_col.find({}, {"_id": 1}):
        if await online_count(u["_id"]) > 0:
            online += 1
    conv_group = await convs_col.count_documents({"type": "group"})
    conv_private = await convs_col.count_documents({"type": "private"})
    msg_total = await msgs_col.count_documents({})
    today_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    msg_today = await msgs_col.count_documents({"created_at": {"$gte": today_start}})
    return {
        "users": {"total": total, "online": online, "disabled": disabled},
        "conversations": {"total": conv_group + conv_private,
                          "group": conv_group, "private": conv_private},
        "messages": {"total": msg_total, "today": msg_today},
    }


@router.get("/metrics")
async def metrics(_: dict = Depends(require_admin)):
    global _last_net
    cpu_percent = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    connections = len(psutil.net_connections(kind="inet"))
    send_rate = recv_rate = None
    now = time.monotonic()
    if _last_net:
        dt = now - _last_net["t"]
        if dt > 0:
            send_rate = int((net.bytes_sent - _last_net["sent"]) / dt)
            recv_rate = int((net.bytes_recv - _last_net["recv"]) / dt)
    _last_net = {"t": now, "sent": net.bytes_sent, "recv": net.bytes_recv}

    redis_info = await redis.info()
    try:
        mongo_status = await db.command("serverStatus")
        try:
            dbstats = await db.command("dbstats")   # 当前库容量
        except Exception:
            dbstats = {}
        mongo_out = {
            "connections": {
                "current": mongo_status.get("connections", {}).get("current"),
                "available": mongo_status.get("connections", {}).get("available"),
            },
            "opcounters": mongo_status.get("opcounters", {}),
            "uptime_sec": mongo_status.get("uptime"),
            "db": {
                "storage_size": dbstats.get("storageSize"),   # 磁盘占用
                "data_size": dbstats.get("dataSize"),         # 未压缩数据量
                "objects": dbstats.get("objects"),
                "collections": dbstats.get("collections"),
            },
        }
    except Exception:
        mongo_out = {"error": "serverStatus 不可用"}

    return {
        "host": {
            "cpu_percent": cpu_percent,
            "cpu_count": psutil.cpu_count(),
            "mem": {"total": mem.total, "used": mem.used, "percent": mem.percent},
            "disk": {"total": disk.total, "used": disk.used, "percent": disk.percent},
            "net": {"connections": connections,
                    "send_rate_bps": send_rate, "recv_rate_bps": recv_rate},
            "uptime_sec": int(time.time() - psutil.boot_time()),
        },
        "redis": {
            "connected_clients": redis_info.get("connected_clients"),
            "used_memory_human": redis_info.get("used_memory_human"),
            "ops_per_sec": redis_info.get("instantaneous_ops_per_sec"),
            "keyspace_hits": redis_info.get("keyspace_hits"),
            "keyspace_misses": redis_info.get("keyspace_misses"),
        },
        "mongo": mongo_out,
    }
