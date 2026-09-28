import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import settings
from app.bootstrap import startup_bootstrap
from app.db import ensure_indexes
from app.routers import admin, auth, convs, files, mcp, sync, think, upload, users, ws
from app.ws import pubsub_listener


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.plugins import load_plugins
    load_plugins()          # 消息插件管道（plugins/plugins.txt 清单制，无清单=直通）
    await ensure_indexes()
    await settings.load()
    await startup_bootstrap()
    listener = asyncio.create_task(pubsub_listener())
    async with mcp.mcp_server.session_manager.run():
        yield
    listener.cancel()


app = FastAPI(title="AgentChat", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, users.router, convs.router, sync.router,
          upload.router, files.router, admin.router, think.router, ws.router):
    app.include_router(r)

# MCP：挂根级 Mount（放路由末尾，仅兜住未匹配路径），对外端点 POST /mcp。
# 用 mount("/mcp") 会在恰好请求 /mcp 时触发 Starlette 的 307 斜杠重定向。
from starlette.routing import Mount  # noqa: E402
app.router.routes.append(Mount("", app=mcp.build_mcp_app()))


@app.get("/")
async def root():
    return {"service": "agentchat", "docs": "/docs"}
