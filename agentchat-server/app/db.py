from motor.motor_asyncio import AsyncIOMotorClient
import redis.asyncio as aioredis

from app import config

mongo_client = AsyncIOMotorClient(config.MONGO_URL)
db = mongo_client[config.MONGO_DB]
users_col = db["users"]
convs_col = db["conversations"]
msgs_col = db["messages"]

redis = aioredis.from_url(config.REDIS_URL, decode_responses=False)


async def ensure_indexes():
    await msgs_col.create_index([("conv_id", 1), ("seq", 1)], unique=True)
    # client_msg_id 幂等硬化：(conv_id, client_msg_id) 唯一（partial：只约束
    # 非 null 键——系统消息的 client_msg_id 为 null，同会话多条 null 不算冲突）。
    # 并发同键插入在索引层被拦，send_message 捕获后回读已有消息返回。
    # 兼容性：协议形状不变（幂等命中仍返回 200 + 已有消息），只是消除了
    # 查询-插入之间的竞态窗口（双 daemon 实例同键回复只落地一条）。
    await msgs_col.create_index(
        [("conv_id", 1), ("client_msg_id", 1)], unique=True,
        partialFilterExpression={"client_msg_id": {"$type": "string"}})
    try:
        await msgs_col.drop_index("client_msg_id_1")  # 旧单列索引去冗余
    except Exception:
        pass                                            # 不存在（新环境）则跳过
    # 历史消息查询：时间过滤/排序 + 会话范围 + 按人过滤
    await msgs_col.create_index([("created_at", -1)])
    try:
        await msgs_col.drop_index("created_at_1")  # 单列方向等价，去冗余（旧版遗留）
    except Exception:
        pass                                        # 索引不存在（新环境）则跳过
    await msgs_col.create_index([("conv_id", 1), ("created_at", -1)])
    await msgs_col.create_index([("sender", 1), ("created_at", -1)])
    await convs_col.create_index([("members", 1)])
    await convs_col.create_index("owner")        # 管理端按发起人（群主）过滤会话
