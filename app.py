import re
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DISCORD_API = "https://discord.com/api/v10"
SNOWFLAKE_RE = re.compile(r"^\d{1,30}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._\-]{20,200}$")

app = FastAPI(title="lurk", docs_url=None, redoc_url=None, openapi_url=None)


class MessagesRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)
    after: Optional[str] = None
    before: Optional[str] = None
    limit: int = Field(default=100, ge=1, le=100)


class ChannelRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)


def _validate(req_token: str, snowflakes: dict[str, Optional[str]]) -> None:
    if not TOKEN_RE.match(req_token):
        raise HTTPException(status_code=400, detail="malformed token")
    for name, value in snowflakes.items():
        if value is not None and not SNOWFLAKE_RE.match(value):
            raise HTTPException(status_code=400, detail=f"invalid {name}")


def _discord_error(resp: httpx.Response) -> HTTPException:
    if resp.status_code == 401:
        return HTTPException(status_code=401, detail="Discord rejected the token")
    if resp.status_code == 403:
        return HTTPException(status_code=403, detail="no access to that channel")
    if resp.status_code == 404:
        return HTTPException(status_code=404, detail="channel not found")
    if resp.status_code == 429:
        retry = resp.headers.get("Retry-After", "1")
        return HTTPException(status_code=429, detail=f"rate-limited by Discord, retry in {retry}s")
    return HTTPException(status_code=502, detail=f"Discord returned HTTP {resp.status_code}")


@app.post("/api/messages")
async def get_messages(req: MessagesRequest):
    _validate(req.token, {"channel_id": req.channel_id, "after": req.after, "before": req.before})

    params: dict[str, str | int] = {"limit": req.limit}
    if req.after:
        params["after"] = req.after
    if req.before:
        params["before"] = req.before

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{DISCORD_API}/channels/{req.channel_id}/messages",
            params=params,
            headers={"Authorization": req.token},
        )

    if resp.status_code != 200:
        raise _discord_error(resp)

    return JSONResponse(resp.json())


@app.post("/api/channel")
async def get_channel(req: ChannelRequest):
    _validate(req.token, {"channel_id": req.channel_id})

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{DISCORD_API}/channels/{req.channel_id}",
            headers={"Authorization": req.token},
        )

    if resp.status_code != 200:
        raise _discord_error(resp)

    data = resp.json()
    return {
        "id": data.get("id"),
        "name": data.get("name"),
        "guild_id": data.get("guild_id"),
        "type": data.get("type"),
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")
