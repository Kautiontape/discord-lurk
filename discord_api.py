import re

import httpx

DISCORD_API = "https://discord.com/api/v10"
SNOWFLAKE_RE = re.compile(r"^\d{1,30}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._\-]{20,200}$")


class DiscordError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def error_for(resp: httpx.Response) -> DiscordError:
    if resp.status_code == 401:
        return DiscordError(401, "Discord rejected the token")
    if resp.status_code == 403:
        return DiscordError(403, "no access to that channel")
    if resp.status_code == 404:
        return DiscordError(404, "channel not found")
    if resp.status_code == 429:
        retry = resp.headers.get("Retry-After", "1")
        return DiscordError(429, f"rate-limited by Discord, retry in {retry}s")
    return DiscordError(502, f"Discord returned HTTP {resp.status_code}")


async def get_channel(token: str, channel_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{DISCORD_API}/channels/{channel_id}",
            headers={"Authorization": token},
        )
    if resp.status_code != 200:
        raise error_for(resp)
    return resp.json()


async def _get_page(client: httpx.AsyncClient, token: str, channel_id: str, params: dict) -> list:
    resp = await client.get(
        f"{DISCORD_API}/channels/{channel_id}/messages",
        params=params,
        headers={"Authorization": token},
    )
    if resp.status_code != 200:
        raise error_for(resp)
    return resp.json()


async def fetch_after(token: str, channel_id: str, after: str, max_pages: int = 50) -> list:
    """All messages newer than `after` (exclusive), ascending by id."""
    collected: dict = {}
    cursor = after
    async with httpx.AsyncClient(timeout=30.0) as client:
        for _ in range(max_pages):
            batch = await _get_page(client, token, channel_id, {"limit": 100, "after": cursor})
            if not batch:
                break
            for m in batch:
                collected[m["id"]] = m
            page_max = max(batch, key=lambda m: int(m["id"]))["id"]
            if page_max == cursor:
                break
            cursor = page_max
            if len(batch) < 100:
                break
    return sorted(collected.values(), key=lambda m: int(m["id"]))


async def fetch_recent(token: str, channel_id: str, limit: int, max_pages: int = 50) -> list:
    """Most recent `limit` messages (first-ever backfill), ascending by id."""
    collected: dict = {}
    before = None
    async with httpx.AsyncClient(timeout=30.0) as client:
        for _ in range(max_pages):
            if len(collected) >= limit:
                break
            params = {"limit": 100}
            if before:
                params["before"] = before
            batch = await _get_page(client, token, channel_id, params)
            if not batch:
                break
            for m in batch:
                collected[m["id"]] = m
            before = min(batch, key=lambda m: int(m["id"]))["id"]
            if len(batch) < 100:
                break
    ordered = sorted(collected.values(), key=lambda m: int(m["id"]))
    return ordered[-limit:]
