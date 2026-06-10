import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import archive
import clean
import discord_api
from discord_api import SNOWFLAKE_RE, TOKEN_RE

app = FastAPI(title="lurk", docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class MessagesRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)
    after: Optional[str] = None
    before: Optional[str] = None
    limit: int = Field(default=100, ge=1, le=100)


class ChannelRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)


class CatchupRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)
    guild_id: str = Field(default="dm", max_length=30)


def backfill_limit() -> int:
    return int(os.environ.get("LURK_BACKFILL_LIMIT", "200"))


def _validate(req_token: str, snowflakes: dict[str, Optional[str]]) -> None:
    if not TOKEN_RE.match(req_token):
        raise HTTPException(status_code=400, detail="malformed token")
    for name, value in snowflakes.items():
        if value is not None and not SNOWFLAKE_RE.match(value):
            raise HTTPException(status_code=400, detail=f"invalid {name}")


def _as_http(e: discord_api.DiscordError) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=e.detail)


@app.post("/api/messages")
async def get_messages(req: MessagesRequest):
    _validate(req.token, {"channel_id": req.channel_id, "after": req.after, "before": req.before})
    params: dict = {"limit": req.limit}
    if req.after:
        params["after"] = req.after
    if req.before:
        params["before"] = req.before
    import httpx
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{discord_api.DISCORD_API}/channels/{req.channel_id}/messages",
            params=params,
            headers={"Authorization": req.token},
        )
    if resp.status_code != 200:
        raise _as_http(discord_api.error_for(resp))
    return JSONResponse(resp.json())


@app.post("/api/channel")
async def get_channel(req: ChannelRequest):
    _validate(req.token, {"channel_id": req.channel_id})
    try:
        data = await discord_api.get_channel(req.token, req.channel_id)
    except discord_api.DiscordError as e:
        raise _as_http(e)
    return {
        "id": data.get("id"),
        "name": data.get("name"),
        "guild_id": data.get("guild_id"),
        "type": data.get("type"),
    }


@app.post("/api/catchup")
async def catchup(req: CatchupRequest):
    _validate(req.token, {"channel_id": req.channel_id})
    base = archive.data_dir()
    last_seen = archive.get_last_seen(base, req.channel_id)
    try:
        if last_seen:
            raw = await discord_api.fetch_after(req.token, req.channel_id, last_seen)
        else:
            raw = await discord_api.fetch_recent(req.token, req.channel_id, backfill_limit())
    except discord_api.DiscordError as e:
        raise _as_http(e)

    cleaned = [clean.clean_message(m) for m in raw]
    appended = archive.append_messages(base, req.guild_id, req.channel_id, cleaned)
    when = datetime.now(timezone.utc).isoformat()
    if cleaned:
        archive.update_pull(
            base, req.channel_id,
            last_seen_id=cleaned[-1]["id"],
            first_added_id=cleaned[0]["id"],
            when=when,
        )
    archive.register_channel(base, {"id": req.channel_id, "guild_id": req.guild_id})
    archive.append_log(base, {
        "at": when, "channel_id": req.channel_id, "guild_id": req.guild_id,
        "fetched": len(cleaned), "appended": appended,
    })
    return {
        "channel_id": req.channel_id,
        "guild_id": req.guild_id,
        "fetched": len(cleaned),
        "appended": appended,
        "total": len(archive.read_archive(base, req.guild_id, req.channel_id)),
        "last_seen_id": archive.get_last_seen(base, req.channel_id),
        "messages": cleaned,
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")
