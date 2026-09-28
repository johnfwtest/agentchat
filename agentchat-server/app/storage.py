"""附件存储适配器：上传/读取按 STORAGE_BACKEND 选择底层，对消息层完全透明。

消息里一律只存相对路径 /files/{date}/{name}（upload.result_md 生成），换后端
不改消息格式。两种实现：

- netdisk（默认）：现有网盘。上传 = 幂等 mkdir + POST /api/upload（body 流式
  转发）；读取经 files 反代容器的 /d/{NETDISK_ROOT}/ 路径（FILES_UPSTREAM）。
  行为与旧版（拆适配器之前）完全一致。
- rustfs：S3 兼容对象存储（RustFS / MinIO 等）。SigV4 **预签名 URL**，零额外
  依赖：上传 = 预签名 PUT（UNSIGNED-PAYLOAD，可流式、Content-Length 已知）；
  读取 = 预签名 GET 由本服务代理（按请求现签、短时效，支持 Range 透传）。
  桶不存在自动创建（等价网盘的幂等 mkdir）。web 侧 /files/ 路由由
  FILES_READ_UPSTREAM 指到本服务（见 docker-compose.yml）。
"""
import hashlib
import hmac
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

import httpx
from fastapi import HTTPException

from app import config


class StorageAdapter:
    """约定：
    put(name, datedir, content, length)  content 为 bytes 或异步字节流（大文件流式）
    open(datedir, name, range) → (httpx.Response, httpx.AsyncClient)  调用方负责
        流式消费 resp 并在结束时 aclose 两者（files 路由统一处理）。
    """

    async def put(self, name: str, datedir: str, content, length: int | None) -> None:
        raise NotImplementedError

    async def open(self, datedir: str, name: str, range_header: str | None):
        raise NotImplementedError


async def _proxy(url: str, range_header: str | None):
    """预签名/反代 GET：返回流式 resp + 待关闭的 client。"""
    client = httpx.AsyncClient(timeout=httpx.Timeout(60, read=300))
    headers = {"range": range_header} if range_header else None
    try:
        resp = await client.send(
            client.build_request("GET", url, headers=headers), stream=True)
    except Exception:
        await client.aclose()
        raise
    return resp, client


class NetdiskStorage(StorageAdapter):
    """现有网盘（与拆适配器前的 upload.post_to_netdisk / files 代理逐行等价）。"""

    async def put(self, name, datedir, content, length):
        try:
            async with httpx.AsyncClient(timeout=float(config.NETDISK_TIMEOUT)) as client:
                # 网盘不自动创建目录：先确保 {root}/{日期} 存在（重复创建报错则忽略）
                try:
                    await client.post(
                        f"{config.NETDISK_BASE_URL}/api/mkdir",
                        json={"path": f"/{config.NETDISK_ROOT}", "name": datedir})
                except httpx.HTTPError:
                    pass
                headers = {"Content-Length": str(length)} if length is not None else None
                r = await client.post(f"{config.NETDISK_BASE_URL}/api/upload",
                                      params={"path": f"{config.NETDISK_ROOT}/{datedir}",
                                              "name": name},
                                      content=content, headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"网盘不可达: {e}")
        if r.status_code >= 400:
            raise HTTPException(502, f"网盘上传失败({r.status_code}): {r.text[:200]}")

    async def open(self, datedir, name, range_header):
        url = f"{config.FILES_UPSTREAM}/files/{datedir}/{name}"
        try:
            return await _proxy(url, range_header)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"文件服务不可达: {e}")


class RustFSStorage(StorageAdapter):
    """S3 兼容对象存储：预签名 PUT/GET（UNSIGNED-PAYLOAD），桶自动创建。"""

    def __init__(self):
        self.endpoint = config.RUSTFS_ENDPOINT.rstrip("/")
        self.bucket = config.RUSTFS_BUCKET
        self.prefix = config.RUSTFS_PREFIX.strip("/")
        self._bucket_ready = False

    def _presign(self, method: str, key: str, expires: int = 3600) -> str:
        """查询串式 SigV4 预签名（X-Amz-SignedHeaders=host，负载不签名）。"""
        host = urlparse(self.endpoint).netloc
        now = datetime.now(timezone.utc)
        datestamp, amz_date = now.strftime("%Y%m%d"), now.strftime("%Y%m%dT%H%M%SZ")
        scope = f"{datestamp}/{config.RUSTFS_REGION}/s3/aws4_request"
        q = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{config.RUSTFS_ACCESS_KEY}/{scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(expires),
            "X-Amz-SignedHeaders": "host",
        }
        canon_q = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}"
                           for k, v in sorted(q.items()))
        resource = f"/{self.bucket}" + (f"/{quote(key, safe='/')}" if key else "")
        canon_req = (f"{method}\n{resource}\n{canon_q}\n"
                     f"host:{host}\n\nhost\nUNSIGNED-PAYLOAD")
        sts = (f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n"
               f"{hashlib.sha256(canon_req.encode()).hexdigest()}")
        k = ("AWS4" + config.RUSTFS_SECRET_KEY).encode()
        for msg in (datestamp, config.RUSTFS_REGION, "s3", "aws4_request"):
            k = hmac.new(k, msg.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
        return f"{self.endpoint}{resource}?{canon_q}&X-Amz-Signature={sig}"

    async def _ensure_bucket(self) -> None:
        """桶不存在则创建（幂等；409=已存在）。数据被清后自动重建。"""
        if self._bucket_ready:
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.put(self._presign("PUT", ""))
        except httpx.HTTPError as e:
            raise HTTPException(502, f"RustFS 不可达: {e}")
        if r.status_code not in (200, 409):
            raise HTTPException(502, f"RustFS 建桶失败({r.status_code}): {r.text[:200]}")
        self._bucket_ready = True

    async def put(self, name, datedir, content, length):
        await self._ensure_bucket()
        url = self._presign("PUT", f"{self.prefix}/{datedir}/{name}")
        headers = {"Content-Length": str(length)} if length is not None else None
        try:
            async with httpx.AsyncClient(timeout=float(config.NETDISK_TIMEOUT)) as client:
                r = await client.put(url, content=content, headers=headers)
        except httpx.HTTPError as e:
            self._bucket_ready = False
            raise HTTPException(502, f"RustFS 不可达: {e}")
        if r.status_code >= 400:
            if r.status_code == 404:
                self._bucket_ready = False   # 桶被删：下次上传前重建
            raise HTTPException(502, f"RustFS 上传失败({r.status_code}): {r.text[:200]}")

    async def open(self, datedir, name, range_header):
        url = self._presign("GET", f"{self.prefix}/{datedir}/{name}")
        try:
            return await _proxy(url, range_header)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"RustFS 不可达: {e}")


def build() -> StorageAdapter:
    backend = config.STORAGE_BACKEND
    if backend == "rustfs":
        if not config.RUSTFS_ACCESS_KEY or not config.RUSTFS_SECRET_KEY:
            raise RuntimeError("STORAGE_BACKEND=rustfs 需配置 RUSTFS_ACCESS_KEY/RUSTFS_SECRET_KEY")
        return RustFSStorage()
    if backend != "netdisk":
        raise RuntimeError(f"未知 STORAGE_BACKEND: {backend}（netdisk | rustfs）")
    return NetdiskStorage()


current = build()
