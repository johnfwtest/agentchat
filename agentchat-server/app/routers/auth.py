from fastapi import APIRouter, HTTPException

from app import security
from app.db import users_col
from app.schemas import LoginIn, LoginOut, now_iso

router = APIRouter(prefix="/api/auth")


LANG_KEY = "ac:user:{u}:lang"     # 用户界面语言（登录时上报；系统消息按发起人语言生成）


@router.post("/login", response_model=LoginOut)
async def login(body: LoginIn):
    from app.db import redis
    user = await users_col.find_one({"_id": body.username})
    if not user or not security.verify_password(
            body.password, user["password_hash"], user["salt"]):
        raise HTTPException(401, "用户名或密码错误")
    if user.get("disabled"):
        raise HTTPException(403, "账号已被禁用")
    if body.lang in ("zh", "en"):
        await redis.set(LANG_KEY.format(u=user["_id"]), body.lang)
    return LoginOut(token=security.create_token(user["_id"], user["role"]),
                    username=user["_id"], role=user["role"])
