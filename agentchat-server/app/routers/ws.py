import asyncio
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app import security
from app.db import users_col
from app.ws import run_ws_session

router = APIRouter()


@router.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query("")):
    payload = security.parse_token(token)
    if not payload:
        await ws.close(code=4401)
        return
    user = await users_col.find_one({"_id": payload["username"]})
    if not user:
        await ws.close(code=4401)
        return
    if user.get("disabled"):
        await ws.close(code=4403)
        return
    await run_ws_session(ws, user["_id"])
