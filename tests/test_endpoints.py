import httpx
import respx
from fastapi.testclient import TestClient

import app as app_module

API = "https://discord.com/api/v10"
client = TestClient(app_module.app)
TOKEN = "abcdefghijklmnopqrstuvwxyz123"


def test_messages_rejects_malformed_token():
    # 23 chars: passes the length constraint but fails TOKEN_RE on the "!" chars,
    # so _validate returns 400 (not Pydantic's 422).
    r = client.post("/api/messages", json={"token": "abcdefghijklmnopqrst!!!", "channel_id": "1"})
    assert r.status_code == 400


@respx.mock
def test_channel_proxies_discord():
    respx.get(f"{API}/channels/55").mock(
        return_value=httpx.Response(200, json={"id": "55", "name": "crypt", "guild_id": "g1", "type": 0}))
    r = client.post("/api/channel", json={"token": TOKEN, "channel_id": "55"})
    assert r.status_code == 200
    assert r.json()["name"] == "crypt"


def test_cors_allows_extension_origin():
    r = client.post(
        "/api/channel",
        json={"token": TOKEN, "channel_id": "55"},
        headers={"Origin": "chrome-extension://abcdef"},
    )
    assert r.headers.get("access-control-allow-origin") == "chrome-extension://abcdef"


def _msg(i):
    return {"id": str(i), "content": f"m{i}",
            "author": {"id": "7", "username": "alice", "global_name": "Alice"},
            "timestamp": "2026-06-09T20:42:00+00:00", "mentions": [], "attachments": [], "embeds": []}


@respx.mock
def test_catchup_first_pull_backfills_and_archives(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LURK_BACKFILL_LIMIT", "200")
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)]))
    r = client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    assert r.status_code == 200
    body = r.json()
    assert body["fetched"] == 3
    assert body["appended"] == 3
    assert body["total"] == 3
    assert body["last_seen_id"] == "3"
    assert [m["id"] for m in body["messages"]] == ["1", "2", "3"]
    assert body["messages"][0]["author"]["name"] == "Alice"


@respx.mock
def test_catchup_second_pull_uses_after_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    # First pull (backfill) returns 1,2,3
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    # Second pull returns only 4,5 (newer); de-dup keeps total at 5
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(5), _msg(4)]))
    r = client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    body = r.json()
    assert body["appended"] == 2
    assert body["total"] == 5
    assert body["last_seen_id"] == "5"


@respx.mock
def test_catchup_maps_discord_error(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(403, json={}))
    r = client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    assert r.status_code == 403
    assert "access" in r.json()["detail"]
