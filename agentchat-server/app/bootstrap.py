"""管理员 bootstrap：启动时 users 为空则创建环境变量指定的管理员；也可 CLI 手动调用。"""
import argparse
import asyncio

from app import config, security
from app.db import users_col
from app.schemas import now_iso


async def ensure_admin(username: str | None = None, password: str | None = None):
    username = username or config.ADMIN_USER
    password = password or config.ADMIN_PASSWORD
    if not username or not password:
        return None
    if await users_col.find_one({"_id": username}):
        return None
    h, salt = security.hash_password(password)
    doc = {"_id": username, "username": username, "password_hash": h,
           "salt": salt, "role": "admin", "disabled": False,
           "created_at": now_iso()}
    await users_col.insert_one(doc)
    return username


async def startup_bootstrap():
    if await users_col.count_documents({}) == 0:
        created = await ensure_admin()
        if created:
            print(f"[bootstrap] created admin user: {created}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    args = p.parse_args()
    created = asyncio.run(ensure_admin(args.username, args.password))
    print(f"created: {created}" if created else "已存在或未创建")
