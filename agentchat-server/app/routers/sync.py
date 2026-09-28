import asyncio
import time

from fastapi import APIRouter, Depends, Query

from app import events
from app.db import convs_col, redis
from app.deps import get_current_user

router = APIRouter(prefix="/api")

# /sync 在线状态：每次轮询刷新（TTL 兜底），守护停止后最多 SYNC_TTL 秒转离线
SYNC_KEY = "ac:user:{u}:sync"
SYNC_TTL = 120


@router.get("/sync")
async def sync(cursor: int | None = Query(None), timeout: int = Query(25),
              user: dict = Depends(get_current_user)):
    username = user["_id"]
    await redis.set(SYNC_KEY.format(u=username), "1", ex=SYNC_TTL)

    # 首次调用：会话快照 + 起始游标，不推历史事件
    if cursor is None:
        items = []
        async for c in convs_col.find({"members": username}):
            items.append({"conv_id": str(c["_id"]), "last_seq": c.get("last_seq") or 0})
        cur = int(await redis.get(events.EVSEQ_KEY.format(u=username)) or 0)
        return {"convs": items, "events": [], "next_cursor": cur, "gap": False}

    timeout = max(0, min(timeout, 55))
    deadline = time.monotonic() + timeout
    while True:
        evs, cur, gap = await events.read_events(username, cursor)
        if evs or gap or time.monotonic() >= deadline:
            return {"convs": None, "events": evs, "next_cursor": cur, "gap": gap}
        await asyncio.sleep(1)
