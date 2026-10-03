import re
from datetime import datetime, timezone

from pydantic import BaseModel, Field

USERNAME_RE = re.compile(r"^[a-z0-9_-]{2,32}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- auth ----------
class LoginIn(BaseModel):
    username: str
    password: str
    lang: str | None = None      # 界面语言（zh/en）：登录时记入 Redis，系统消息按发起人语言生成


class LoginOut(BaseModel):
    token: str
    username: str
    role: str


# ---------- users ----------
class UserOut(BaseModel):
    username: str
    role: str
    online: bool = False
    disabled: bool = False
    created_at: str | None = None


class CreateUserIn(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=1)


class UpdateUserIn(BaseModel):
    password: str | None = None
    disabled: bool | None = None


# ---------- user profile（头像点击卡片：tags + 个性签名） ----------
class ProfileIn(BaseModel):
    tags: list[str] = []
    bio: str = Field(default="", max_length=400)   # 服务端再截到 BIO_MAX


# ---------- conversations ----------
class ConvOut(BaseModel):
    id: str
    type: str
    name: str | None = None
    desc: str = ""
    members: list[str]
    owner: str | None = None
    last_seq: int = 0
    last_msg: dict | None = None
    created_at: str | None = None


class CreatePrivateIn(BaseModel):
    peer: str


class CreateGroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    members: list[str] = []
    desc: str = Field(default="", max_length=200)   # 群描述（可选）


class UpdateGroupIn(BaseModel):
    # PATCH /api/convs/{id}：改名 / 改描述（均仅群主），至少传一项
    name: str | None = Field(default=None, min_length=1, max_length=64)
    desc: str | None = Field(default=None, max_length=200)


class AddMemberIn(BaseModel):
    username: str


# ---------- messages ----------
class ReplyToOut(BaseModel):
    seq: int
    sender: str
    excerpt: str


class MessageOut(BaseModel):
    id: str
    conv_id: str
    seq: int
    sender: str
    type: str
    content: str
    mentions: list[str] = []
    reactions: list[dict] = []
    reply_to: dict | None = None
    client_msg_id: str | None = None
    created_at: str | None = None


class SendMessageIn(BaseModel):
    # 硬上限 65536（pydantic 层兜底）；实际长度按管理页 msg_max_len 动态限制
    content: str = Field(min_length=1, max_length=65536)
    reply_to_seq: int | None = None
    client_msg_id: str | None = Field(default=None, max_length=64)
    # 内容形态信令（0=plain 缺省；已注册值见 app/plugins.py CODECS，未知值 400）。
    # 独立于插件：客户端可自带形态（如端侧加密），插件管道亦可改写
    codec: int = Field(default=0, ge=0, le=255)


# ---------- think（瞬态思考流，不入库） ----------
class ThinkIn(BaseModel):
    text: str = Field(default="", max_length=131072)  # 服务端再按 THINK_MAX 截尾
    done: bool = False
    # 分享 key 的确定性原料（推荐传触发消息的 id）：同一 source → 同一分享 URL，
    # 静默超时被清理后恢复上报链接不变。缺省按 会话+用户+当日 兜底（同日稳定）
    source: str | None = Field(default=None, max_length=128)


# ---------- upload ----------
class UploadOut(BaseModel):
    url: str
    filename: str
    markdown: str


# ---------- admin settings ----------
class UpdateSettingsIn(BaseModel):
    upload_max_mb: int | None = None
    msg_max_len: int | None = None
    msg_page_size: int | None = None
    think_keep_minutes: int | None = None
    events_keep: int | None = None
    token_ttl_days: int | None = None
