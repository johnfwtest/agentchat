import re
import time
from datetime import date
from typing import AsyncIterable
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from app import config, settings, storage
from app.deps import get_current_user

router = APIRouter(prefix="/api")
UNSAFE_RE = re.compile(r"[^A-Za-z0-9._\-\u4e00-\u9fff]")


def make_names(filename: str) -> tuple[str, str]:
    """(存储名, 日期目录)：原名加毫秒时间戳防重，按日期分目录（后端无关）。"""
    raw_name = re.sub(r"\s+", "_", (filename or "file").split("/")[-1].split("\\")[-1])
    raw_name = UNSAFE_RE.sub("", raw_name) or "file"
    if "." in raw_name[1:]:
        stem, ext = raw_name.rsplit(".", 1)
        ext = "." + ext
    else:
        stem, ext = raw_name, ""
    name = f"{stem}-{int(time.time() * 1000)}{ext}"
    return name, date.today().isoformat()


def result_md(name: str, datedir: str, type: str) -> dict:
    # 消息内相对路径不含存储根：/files/{date}/{name}，两种后端一致——
    # netdisk 由 files 容器映射到网盘 /d/{NETDISK_ROOT}/；rustfs 由本服务按
    # RUSTFS_PREFIX 解析（见 app/storage.py 与 docker-compose 的 FILES_READ_UPSTREAM）
    url = f"{config.NETDISK_FILE_PREFIX}/{datedir}/{quote(name)}"
    md = f"![{name}]({url})" if type == "image" else f"[{name}]({url})"
    return {"url": url, "filename": name, "markdown": md}


def check_size(size: int) -> None:
    max_mb = settings.current("upload_max_mb")
    if size > max_mb * 1024 * 1024:
        raise HTTPException(400, f"文件超过 {max_mb}MB 限制")


async def upload_bytes(filename: str, data: bytes, type: str) -> dict:
    """整包上传（MCP 工具用，数据已在内存）。"""
    check_size(len(data))
    name, datedir = make_names(filename)
    await storage.current.put(name, datedir, data, len(data))
    return result_md(name, datedir, type)


@router.post("/upload")
async def upload(type: str = Query("file"), file: UploadFile = File(...),
                 user: dict = Depends(get_current_user)):
    size = file.size  # 请求头已知大小，超限直接拒绝，不读 body
    if size is None:
        data = await file.read()
        check_size(len(data))
        name, datedir = make_names(file.filename)
        await storage.current.put(name, datedir, data, len(data))
        return result_md(name, datedir, type)
    check_size(size)
    name, datedir = make_names(file.filename)

    async def stream() -> AsyncIterable[bytes]:
        while True:
            chunk = await file.read(4 * 1024 * 1024)
            if not chunk:
                break
            yield chunk

    # 流式转发：大文件不整体进后端内存
    await storage.current.put(name, datedir, stream(), size)
    return result_md(name, datedir, type)
