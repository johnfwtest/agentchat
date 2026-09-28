from fastapi import APIRouter, HTTPException

from app import security
from app.db import users_col
from app.schemas import LoginIn, LoginOut, now_iso

router = APIRouter(prefix="/api/auth")


@router.post("/login", response_model=LoginOut)
async def login(body: LoginIn):
    user = await users_col.find_one({"_id": body.username})
    if not user or not security.verify_password(
            body.password, user["password_hash"], user["salt"]):
        raise HTTPException(401, "用户名或密码错误")
    if user.get("disabled"):
        raise HTTPException(403, "账号已被禁用")
    return LoginOut(token=security.create_token(user["_id"], user["role"]),
                    username=user["_id"], role=user["role"])
