import hashlib
import secrets
import time

import jwt

from app import config, settings


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return h, salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    h, _ = hash_password(password, salt)
    return secrets.compare_digest(h, password_hash)


def create_token(username: str, role: str) -> str:
    now = int(time.time())
    payload = {"username": username, "role": role, "iat": now,
               "exp": now + settings.current("token_ttl_days") * 86400}
    return jwt.encode(payload, config.JWT_SECRET, algorithm="HS256")


def parse_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
