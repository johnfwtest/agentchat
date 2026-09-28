import re

from fastapi import Depends, HTTPException, Request

from app import security
from app.db import users_col

USERNAME_RE = re.compile(r"^[a-z0-9_-]{2,32}$")


async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    payload = security.parse_token(token)
    if not payload:
        raise HTTPException(401, "无效或过期的 Token")
    user = await users_col.find_one({"_id": payload["username"]})
    if not user:
        raise HTTPException(401, "账号不存在")
    if user.get("disabled"):
        raise HTTPException(403, "账号已被禁用")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user
