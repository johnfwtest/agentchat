"""用户事件流：每用户递增 ev 号 + Redis List 暂存（/sync 源）+ Pub/Sub（WS 桥）。"""
import json

from app import settings
from app.db import redis

EVSEQ_KEY = "ac:user:{u}:evseq"
EVENTS_KEY = "ac:user:{u}:events"
CHAN = "ac:chan:user:{u}"


def keep_size() -> int:
    """暂存窗口大小：管理页「系统参数」的 events_keep（默认 1000，改后即时生效）。

    缩小窗口是惰性的（下次 LPUSH 时 LTRIM 才裁），不需要回扫所有用户的 List。
    """
    return settings.current("events_keep")


async def publish_event(username: str, event: dict) -> int:
    """为用户生成 ev 号、写入事件暂存并 PUBLISH。返回 ev 号。"""
    ev = await redis.incr(EVSEQ_KEY.format(u=username))
    event["ev"] = ev
    payload = json.dumps(event, ensure_ascii=False)
    key = EVENTS_KEY.format(u=username)
    pipe = redis.pipeline()
    pipe.lpush(key, payload)
    pipe.ltrim(key, 0, keep_size() - 1)
    await pipe.execute()
    await redis.publish(CHAN.format(u=username), payload)
    return ev


async def publish_transient(username: str, event: dict) -> None:
    """瞬态事件：只 PUBLISH 给在线 WS，不进事件 List、不动 evseq。

    /sync 消费面与 gap 检测完全无感知；离线方自然错过（by design，
    如 think 消息——允许丢失，最终正式消息才是权威结果）。
    """
    payload = json.dumps(event, ensure_ascii=False)
    await redis.publish(CHAN.format(u=username), payload)


async def read_events(username: str, cursor: int) -> tuple[list[dict], int, bool]:
    """读取 ev > cursor 的事件（升序）。返回 (events, current_evseq, gap)。

    gap=True 表示「事件流不连续、必须重同步」，两种来源：
      1) cur < cursor：计数器回退——Redis 被清空 / 服务端重置，客户端游标已失去意义。
         必须在这里报 gap：否则 cur <= cursor 会永远返回空列表，客户端被静默卡死
         （就是「服务端重启后给 agent 发消息没有回复」那个现象）。
      2) 暂存窗口内最小 ev 已大于 cursor+1：中间事件已被裁剪（窗口大小 = 管理页「系统参数」
         的 events_keep，默认 1000）。
    客户端收到 gap 后应重新拉快照并自行对账（游标重置 + 按 last_seq 补消息）。
    """
    cur = int(await redis.get(EVSEQ_KEY.format(u=username)) or 0)
    if cur < cursor:
        return [], cur, True
    if cur == cursor:
        return [], cursor, False
    raw = await redis.lrange(EVENTS_KEY.format(u=username), 0, -1)
    items = sorted((json.loads(x) for x in raw), key=lambda e: e["ev"])
    selected = [e for e in items if e["ev"] > cursor]
    # 暂存窗口内最小 ev 已大于 cursor+1 → 中间事件被裁剪
    gap = bool(items) and items[0]["ev"] > cursor + 1
    return selected, cur, gap
