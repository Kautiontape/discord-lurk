import httpx
import pytest
import respx

import discord_api

API = "https://discord.com/api/v10"


def _msg(i):
    return {"id": str(i), "content": f"m{i}", "author": {"id": "7", "username": "a"},
            "timestamp": "2026-06-09T20:42:00+00:00"}


@respx.mock
async def test_get_channel_returns_payload():
    respx.get(f"{API}/channels/c1").mock(
        return_value=httpx.Response(200, json={"id": "c1", "name": "crypt", "guild_id": "g1", "type": 0}))
    out = await discord_api.get_channel("tok", "c1")
    assert out["name"] == "crypt"


@respx.mock
async def test_get_channel_maps_401_to_discord_error():
    respx.get(f"{API}/channels/c1").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(discord_api.DiscordError) as ei:
        await discord_api.get_channel("tok", "c1")
    assert ei.value.status_code == 401
    assert "token" in ei.value.detail


@respx.mock
async def test_fetch_after_paginates_forward_until_partial_page():
    # Discord returns newest-first; `after` walks forward chronologically.
    # Page 1 is full (100 messages) so pagination continues; page 2 is partial → stop.
    page1 = [_msg(i) for i in range(200, 100, -1)]   # ids 200..101, newest-first, 100 msgs
    page2 = [_msg(i) for i in range(205, 200, -1)]   # ids 205..201, newest-first, 5 msgs (< 100 → stop)
    route = respx.get(f"{API}/channels/c1/messages")
    route.side_effect = [
        httpx.Response(200, json=page1),
        httpx.Response(200, json=page2),
    ]
    out = await discord_api.fetch_after("tok", "c1", after="100")
    assert [m["id"] for m in out] == [str(i) for i in range(101, 206)]
    assert len(out) == 105


@respx.mock
async def test_fetch_recent_returns_last_n_ascending():
    route = respx.get(f"{API}/channels/c1/messages")
    route.side_effect = [httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)])]
    out = await discord_api.fetch_recent("tok", "c1", limit=2)
    assert [m["id"] for m in out] == ["2", "3"]
