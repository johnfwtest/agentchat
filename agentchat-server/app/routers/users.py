from fastapi import APIRouter, Depends, HTTPException

from app.db import users_col
from app.deps import get_current_user
from app.schemas import ProfileIn, UserOut
from app.ws import online_count

router = APIRouter(prefix="/api")

TAGS_MAX, TAG_LEN_MAX, BIO_MAX = 10, 24, 200


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {"username": user["_id"], "role": user["role"],
            "created_at": user.get("created_at")}


@router.get("/users")
async def list_users(_: dict = Depends(get_current_user)):
    out = []
    async for u in users_col.find():
        out.append(UserOut(
            username=u["_id"], role=u["role"],
            online=await online_count(u["_id"]) > 0,
            disabled=bool(u.get("disabled")),
            created_at=u.get("created_at"),
        ))
    return {"users": out}


def profile_out(u: dict) -> dict:
    return {"username": u["_id"], "role": u["role"],
            "tags": u.get("tags") or [], "bio": u.get("bio") or "",
            "created_at": u.get("created_at")}


@router.get("/users/{username}/profile")
async def get_profile(username: str, _: dict = Depends(get_current_user)):
    """用户 Profile（头像点击卡片）：tags + 个性签名，所有登录用户可看。"""
    u = await users_col.find_one({"_id": username})
    if not u:
        raise HTTPException(404, "用户不存在")
    return profile_out(u)


@router.put("/users/{username}/profile")
async def put_profile(username: str, body: ProfileIn,
                      user: dict = Depends(get_current_user)):
    """修改 Profile：本人或管理员。tags ≤10 个（每个 ≤24 字符），bio ≤200 字符。"""
    if user["_id"] != username and user.get("role") != "admin":
        raise HTTPException(403, "只能修改自己的资料，或由管理员修改")

    target = await users_col.find_one({"_id": username})
    if not target:
        raise HTTPException(404, "用户不存在")

    tags: list[str] = []
    for t in body.tags:
        t = (t or "").strip()
        if not t:
            continue
        if len(t) > TAG_LEN_MAX:
            raise HTTPException(400, f"标签「{t[:10]}…」超过 {TAG_LEN_MAX} 字符")
        if t not in tags:
            tags.append(t)
    if len(tags) > TAGS_MAX:
        raise HTTPException(400, f"标签最多 {TAGS_MAX} 个")
    bio = (body.bio or "").strip()
    if len(bio) > BIO_MAX:
        raise HTTPException(400, f"个性签名超过 {BIO_MAX} 字符")

    await users_col.update_one({"_id": username},
                               {"$set": {"tags": tags, "bio": bio}})
    return {**profile_out(target), "tags": tags, "bio": bio}
