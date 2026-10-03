"""运行时系统参数：默认值来自 config（环境变量），管理页修改后存 Mongo 并即时生效。

热路径（上传校验、消息长度、签发 token、事件暂存裁剪）走同步 current()，内存值由
load()（启动）与 update()（管理页保存）维护，单实例部署下无一致性问题。
"""
from fastapi import HTTPException

from app import config
from app.db import db

FIELDS = {
    "upload_max_mb": {"default": config.UPLOAD_MAX_BYTES // (1024 * 1024),
                      "min": 1, "max": 51200, "label": "Max upload size (MB, 1~51200 = 50G)"},
    "msg_max_len": {"default": config.MSG_MAX_LEN,
                    "min": 256, "max": 65536, "label": "Max message length (chars)"},
    "msg_page_size": {"default": config.MSG_PAGE_SIZE,
                      "min": 10, "max": 500,
                      "label": "Message segment size (batch size; seq segment addressing unit)"},
    "think_keep_minutes": {"default": config.THINK_KEEP_MINUTES,
                           "min": 1, "max": 1440,
                           "label": "Think retention (minutes; viewable/shareable after completion, lost on expiry)"},
    "events_keep": {"default": config.EVENTS_KEEP,
                    "min": 100, "max": 100000,
                    "label": "Per-user event buffer size (/sync reconnect backtrack window)"},
    "token_ttl_days": {"default": config.TOKEN_TTL_DAYS,
                       "min": 1, "max": 365, "label": "Login token lifetime (days)"},
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
            raise HTTPException(400, f"{f['label']} must be an integer in {f['min']}~{f['max']}")
        clean[k] = v
    if not clean:
        raise HTTPException(400, "No valid fields to update")
    _state = {**_state, **clean}
    await db["settings"].update_one({"_id": "global"},
                                    {"$set": {**clean, "_id": "global"}}, upsert=True)
    return dict(_state)
