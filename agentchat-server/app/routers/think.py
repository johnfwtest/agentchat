"""think 消息：Agent 思考流（第三种消息类型，瞬态、不落库、允许丢失）。

与 text/system 并列，但完全不进 send_message 链路：不占 seq、不写 Mongo、
不进 /sync 事件 List、不算未读；历史查询不可见。只经 Pub/Sub 实时推给
在线 WS 客户端；当前内容在 Redis hash 里尽力暂存，供页面刷新/重连按需拉回。

**分享与保留**（2026-09-20 起）：分享 key 是**确定性**的——
`key = sha1(conv_id|source)[:16]`，source 由调用方提供（推荐传触发消息的 id，
daemon 天然可得；MCP 不传则按 `conv_id|sender|当天日期` 兜底，同日稳定）。
好处：思考静默超过 think_keep_minutes 被清理后，agent 恢复上报算出**同一个
key**——丢的只是内容（丢了就丢了），分享 URL 永不变、复活即有效。
正式消息发出 = 思考结束：标记 done 并把 Redis TTL 续为管理页
`think_keep_minutes`（默认 30 分钟），期间 `GET /api/think/{key}` 可回看，
过期/主动清除即 404。前端拉会话 think 时过滤 done=true（气泡不复活）。
"""
import hashlib
import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException

from app import events, settings
from app.db import redis
from app.deps import get_current_user
from app.routers.convs import get_conv_or_404
from app.schemas import ThinkIn, now_iso

router = APIRouter(prefix="/api")

THINK_KEY = "ac:conv:{cid}:think"          # hash：field=sender → {id,text,at,done}
THINK_GUID_KEY = "ac:think:{key}"          # key → "conv_id|sender"（小索引，TTL 同步）
THINK_MAX = 65536                          # 单条内容上限（字符），超出保留尾部


def _decode(b: bytes | str) -> str:
    return b.decode() if isinstance(b, bytes) else b


def _keep_minutes() -> int:
    return settings.current("think_keep_minutes")


def think_key(conv_id: str, sender: str, source: str | None) -> str:
    """确定性分享 key：同一 source → 同一 key（静默清理后恢复上报，URL 不变）。"""
    if not source:
        source = f"{sender}|{date.today().isoformat()}"   # 兜底：同会话同人同日稳定
    return hashlib.sha1(f"{conv_id}|{source}".encode()).hexdigest()[:16]


async def _refresh_ttl(conv_id: str, key: str | None = None) -> None:
    ttl = _keep_minutes() * 60
    await redis.expire(THINK_KEY.format(cid=conv_id), ttl)
    if key:
        await redis.expire(THINK_GUID_KEY.format(key=key), ttl)


async def set_think(conv: dict, sender: str, text: str, done: bool = False,
                    source: str | None = None) -> dict:
    """更新/清除一个 sender 的 think 状态并广播（只 PUBLISH，瞬态）。

    source：分享 key 的确定性原料（推荐触发消息 id）。空 text 且非 done =
    主动清除（真删；清除时传的 source 须与创建时一致才能一并删掉索引，
    不一致也无害——索引靠 TTL 兜底过期）。
    """
    conv_id = conv["_id"]
    key = think_key(conv_id, sender, source)
    hkey = THINK_KEY.format(cid=conv_id)
    if len(text) > THINK_MAX:
        text = text[-THINK_MAX:]

    raw = await redis.hget(hkey, sender)
    try:
        cur = json.loads(_decode(raw)) if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        cur = None
    # 复用 hash 里已存的 key（创建时的 source 可能与本次不同，以存量为准；
    # 数据已被 TTL 清掉时用本次算出的 key 重新开始——确定性保证 URL 不变）
    if cur and cur.get("id"):
        key = cur["id"]

    at = now_iso()
    if not text and not done:                      # 主动清除：真删
        await redis.hdel(hkey, sender)
        await redis.delete(THINK_GUID_KEY.format(key=key))
    else:
        await redis.hset(hkey, sender,
                         json.dumps({"id": key, "text": text, "at": at,
                                     "done": bool(done or (cur or {}).get("done"))},
                                    ensure_ascii=False))
        await redis.set(THINK_GUID_KEY.format(key=key), f"{conv_id}|{sender}")
        await _refresh_ttl(conv_id, key)
    event = {"type": "think", "conv_id": conv_id, "sender": sender,
             "id": key, "text": text, "done": done, "at": at}
    for member in set(conv["members"]):
        await events.publish_transient(member, event)
    return {"ok": True, "id": key}


async def finish_think_on_message(conv_id: str, sender: str) -> None:
    """正式消息落库后由 send_message 调用：思考结束，标记 done 并按
    think_keep_minutes 保留（分享链接在保留期内可回看，过期自清）。
    不广播——前端气泡本来就由 message 事件自动清除。
    """
    key = THINK_KEY.format(cid=conv_id)
    raw = await redis.hget(key, sender)
    if not raw:
        return
    try:
        cur = json.loads(_decode(raw))
    except (json.JSONDecodeError, UnicodeDecodeError):
        await redis.hdel(key, sender)
        return
    if cur.get("done"):
        await _refresh_ttl(conv_id, cur.get("id"))
        return
    cur["done"] = True
    await redis.hset(key, sender, json.dumps(cur, ensure_ascii=False))
    key_id = cur.get("id")
    if key_id:
        await redis.set(THINK_GUID_KEY.format(key=key_id), f"{conv_id}|{sender}")
    await _refresh_ttl(conv_id, key_id)


async def get_thinks(conv_id: str, include_done: bool = False) -> list[dict]:
    """当前会话的 think 状态（按时间排序）。默认过滤 done（完成的气泡不再显示）。"""
    raw = await redis.hgetall(THINK_KEY.format(cid=conv_id))
    out = []
    for sender, val in raw.items():
        try:
            d = json.loads(_decode(val))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not include_done and d.get("done"):
            continue
        out.append({"sender": _decode(sender), "id": d.get("id"),
                    "text": d.get("text") or "", "at": d.get("at") or "",
                    "done": bool(d.get("done"))})
    out.sort(key=lambda x: x["at"])
    return out


async def _member_conv(conv_id: str, username: str) -> dict:
    conv = await get_conv_or_404(conv_id)
    if username not in conv["members"]:
        raise HTTPException(403, "不是会话成员")
    return conv


@router.put("/convs/{conv_id}/think")
async def put_think(conv_id: str, body: ThinkIn,
                    user: dict = Depends(get_current_user)):
    conv = await _member_conv(conv_id, user["_id"])
    return await set_think(conv, user["_id"], body.text, body.done, body.source)


@router.get("/convs/{conv_id}/think")
async def list_thinks(conv_id: str, user: dict = Depends(get_current_user)):
    """按需拉取当前 think 状态（刷新/重连恢复用；完成的不显示）。"""
    conv = await _member_conv(conv_id, user["_id"])
    return {"thinks": await get_thinks(conv_id)}


@router.get("/think/{guid}")
async def get_think_by_guid(guid: str, _: dict = Depends(get_current_user)):
    """按 GUID 回看思考快照（分享 URL 用）。任何登录用户；过期/不存在 404。"""
    if not guid or len(guid) > 64:
        raise HTTPException(404, "思考内容不存在或已过期")
    idx = await redis.get(THINK_GUID_KEY.format(key=guid))
    if not idx:
        raise HTTPException(404, "思考内容不存在或已过期")
    conv_id, _, sender = _decode(idx).partition("|")
    raw = await redis.hget(THINK_KEY.format(cid=conv_id), sender)
    try:
        d = json.loads(_decode(raw)) if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        d = None
    if not d:
        raise HTTPException(404, "思考内容不存在或已过期")
    return {"id": guid, "conv_id": conv_id, "sender": sender,
            "text": d.get("text") or "", "at": d.get("at") or "",
            "done": bool(d.get("done"))}
