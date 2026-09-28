import os


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


REDIS_URL = env("REDIS_URL", "redis://localhost:6379/0")
MONGO_URL = env("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = env("MONGO_DB", "agentchat")
JWT_SECRET = env("JWT_SECRET", "dev-secret")
TOKEN_TTL_DAYS = 30

# 默认值仅为占位（历史部署用过的内网地址）；生产/新部署必须用 env("NETDISK_BASE_URL", ...)
# 显式覆盖为实际网盘地址（参考 docker-compose.yml 同名环境变量）。
NETDISK_BASE_URL = env("NETDISK_BASE_URL", "http://192.168.1.10:8090")
NETDISK_ROOT = env("NETDISK_ROOT", "im")
# 已实测（2026-09-12）：下载 URL 为 {base}/d/{path}/{name}；上传前需 mkdir（网盘不自动建目录）
# 网盘读写统一走 files 反代容器（compose 内 NETDISK_BASE_URL=http://files:80），
# 消息里只存相对路径 {NETDISK_FILE_PREFIX}/{path}/{name}——换域名 / 端口转发不受影响
NETDISK_FILE_PREFIX = env("NETDISK_FILE_PREFIX", "/files")
FILES_UPSTREAM = env("FILES_UPSTREAM", "http://files:80")
# 后端→网盘上传的超时秒数（大文件传输需要足够长，compose 可配）
NETDISK_TIMEOUT = env("NETDISK_TIMEOUT", "3600")

# ---------- 附件存储适配器（app/storage.py）：netdisk | rustfs ----------
# 两种后端对消息层透明（消息里只存 /files/{date}/{name} 相对路径）。
# rustfs（S3 兼容对象存储，SigV4 预签名上传/读取，桶自动创建）需要：
STORAGE_BACKEND = env("STORAGE_BACKEND", "netdisk")
RUSTFS_ENDPOINT = env("RUSTFS_ENDPOINT", "http://localhost:9000")
RUSTFS_ACCESS_KEY = env("RUSTFS_ACCESS_KEY", "")
RUSTFS_SECRET_KEY = env("RUSTFS_SECRET_KEY", "")
RUSTFS_BUCKET = env("RUSTFS_BUCKET", "agentchat")
RUSTFS_PREFIX = env("RUSTFS_PREFIX", "im")     # 对象 key 前缀（与网盘 NETDISK_ROOT 同位）
RUSTFS_REGION = env("RUSTFS_REGION", "us-east-1")

ADMIN_USER = env("ADMIN_USER", "admin")
ADMIN_PASSWORD = env("ADMIN_PASSWORD", "admin123")

UPLOAD_MAX_BYTES = 100 * 1024 * 1024
MSG_MAX_LEN = 16384
MSG_PAGE_SIZE = 100          # 消息分段大小默认值（运行时可由管理页 msg_page_size 覆盖）
THINK_KEEP_MINUTES = 30      # think 思考内容保留时长默认值（分钟，管理页可改）
EVENTS_KEEP = 1000
USERNAME_RE = r"^[a-z0-9_-]{2,32}$"
