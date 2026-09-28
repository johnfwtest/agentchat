from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import storage

router = APIRouter()

# 附件直读（公开无鉴权：<img> 标签带不了 token，与底层存储可公开读一致）。
# 消息里存的是相对路径 /files/{date}/{name}，读取统一交给存储适配器：
# netdisk → files 反代容器；rustfs → 本服务预签名 GET 代理（支持 Range）。
# Agent 以 API 源（:8000）同样可直连下载。
PASS_HEADERS = {"content-type", "content-length", "content-disposition",
                "accept-ranges", "content-range", "etag", "last-modified"}


# FastAPI 的 get 路由不自动接受 HEAD（会落到 MCP 根挂载被 401），显式声明
@router.api_route("/files/{path:path}", methods=["GET", "HEAD"])
async def files_proxy(path: str, request: Request):
    datedir, _, name = path.partition("/")
    if not name:
        raise HTTPException(404, "文件不存在")
    resp, client = await storage.current.open(datedir, name,
                                              request.headers.get("range"))

    async def stream():
        try:
            async for chunk in resp.aiter_bytes(65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    out = {k: v for k, v in resp.headers.items() if k.lower() in PASS_HEADERS}
    return StreamingResponse(stream(), status_code=resp.status_code, headers=out)
