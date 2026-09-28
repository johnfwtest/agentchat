"""运行时系统参数：默认值来自 config（环境变量），管理页修改后存 Mongo 并即时生效。

热路径（上传校验、消息长度、签发 token、事件暂存裁剪）走同步 current()，内存值由
load()（启动）与 update()（管理页保存）维护，单实例部署下无一致性问题。
"""
from fastapi import HTTPException

from app import config
from app.db import db

FIELDS = {
    "upload_max_mb": {"default": config.UPLOAD_MAX_BYTES // (1024 * 1024),
                      "min": 1, "max": 51200, "label": "附件大小上限（MB，1~51200 即最大 50G）"},
    "msg_max_len": {"default": config.MSG_MAX_LEN,
                    "min": 256, "max": 65536, "label": "单条消息最大长度（字符）"},
    "msg_page_size": {"default": config.MSG_PAGE_SIZE,
                      "min": 10, "max": 500,
                      "label": "消息分段大小（每批加载条数，seq 分段寻址的对齐单位）"},
    "think_keep_minutes": {"default": config.THINK_KEEP_MINUTES,
                           "min": 1, "max": 1440,
                           "label": "think 思考内容保留时长（分钟，完成后可回看/分享，过期即失）"},
    "events_keep": {"default": config.EVENTS_KEEP,
                    "min": 100, "max": 100000,
                    "label": "每用户事件流暂存条数（/sync 断线重连的回溯窗口）"},
    "token_ttl_days": {"default": config.TOKEN_TTL_DAYS,
                       "min": 1, "max": 365, "label": "登录 Token 有效期（天）"},
}

_state: dict = {k: f["default"] for k, f in FIELDS.items()}


async def load() -> None:
    """启动时合并 Mongo settings 集合中保存过的值。"""
    global _state
    doc = await db["settings"].find_one({"_id": "global"}) or {}
    _state = {k: doc.get(k, f["default"]) for k, f in FIELDS.items()}


def current(key: str):
    return _state[key]


def snapshot() -> dict:
    return {"values": dict(_state),
            "fields": {k: {"default": f["default"], "min": f["min"],
                           "max": f["max"], "label": f["label"]}
                       for k, f in FIELDS.items()}}


async def update(patch: dict) -> dict:
    """校验范围后落库并更新内存，返回全部当前值。"""
    global _state
    clean: dict = {}
    for k, v in patch.items():
        if v is None or k not in FIELDS:
            continue
        f = FIELDS[k]
        if isinstance(v, bool) or not isinstance(v, int) \
                or not f["min"] <= v <= f["max"]:
            raise HTTPException(400, f"{f['label']} 须为 {f['min']}~{f['max']} 的整数")
        clean[k] = v
    if not clean:
        raise HTTPException(400, "无有效更新字段")
    _state = {**_state, **clean}
    await db["settings"].update_one({"_id": "global"},
                                    {"$set": {**clean, "_id": "global"}}, upsert=True)
    return dict(_state)
