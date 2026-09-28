"""WebSocket 连接管理、Pub/Sub 桥、在线计数。"""
import asyncio
import json

from fastapi import WebSocket

from app.db import convs_col, redis
from app.events import CHAN

ONLINE_KEY = "ac:user:{u}:online"


class ConnectionManager:
    def __init__(self):
        self.connections: dict[str, set[WebSocket]] = {}

    def register(self, username: str, ws: WebSocket):
        self.connections.setdefault(username, set()).add(ws)

    def unregister(self, username: str, ws: WebSocket):
        conns = self.connections.get(username)
        if conns:
            conns.discard(ws)
            if not conns:
                self.connections.pop(username, None)

    async def send_to_user(self, username: str, payload: str):
        for ws in list(self.connections.get(username, ())):
            try:
                await ws.send_text(payload)
            except Exception:
                self.unregister(username, ws)

    async def kick_user(self, username: str):
        """禁用踢线：通知所有连接后关闭。"""
        for ws in list(self.connections.get(username, ())):
            try:
                await ws.send_text(json.dumps({"type": "kick", "reason": "disabled"}))
                await ws.close(code=1000)
            except Exception:
                pass
        self.connections.pop(username, None)


manager = ConnectionManager()


async def online_count(username: str) -> int:
    """在线 = WS 连接数>0 或 /sync 长轮询活跃（TTL key，见 routers/sync.py）。"""
    ws_n = max(0, int(await redis.get(ONLINE_KEY.format(u=username)) or 0))
    if ws_n > 0:
        return ws_n
    if await redis.exists("ac:user:{u}:sync".format(u=username)):
        return 1
    return 0


async def inc_online(username: str):
    await redis.incr(ONLINE_KEY.format(u=username))


async def dec_online(username: str):
    key = ONLINE_KEY.format(u=username)
    n = await redis.decr(key)
    if n < 0:
        await redis.set(key, 0)


async def ready_snapshot(username: str) -> dict:
    convs = convs_col.find({"members": username})
    items = [{"conv_id": str(c["_id"]), "last_seq": c.get("last_seq") or 0}
             async for c in convs]
    return {"type": "ready", "convs": items}


async def pubsub_listener():
    """常驻任务：订阅所有用户频道，转发到本实例的 WS 连接。"""
    pubsub = redis.pubsub()
    await pubsub.psubscribe(CHAN.format(u="*"))
    async for msg in pubsub.listen():
        if msg["type"] != "pmessage":
            continue
        channel = msg["channel"]
        channel = channel.decode() if isinstance(channel, bytes) else channel
        username = channel.rsplit(":", 1)[-1]
        data = msg["data"]
        payload = data.decode() if isinstance(data, bytes) else data
        await manager.send_to_user(username, payload)


async def run_ws_session(ws: WebSocket, username: str):
    """WS 会话主循环：注册、ready、心跳、退出清理。"""
    await ws.accept()
    await inc_online(username)
    manager.register(username, ws)
    try:
        await ws.send_text(json.dumps(await ready_snapshot(username)))
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=120)
            try:
                if json.loads(raw).get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except (asyncio.TimeoutError, Exception):
        pass
    finally:
        manager.unregister(username, ws)
        await dec_online(username)
