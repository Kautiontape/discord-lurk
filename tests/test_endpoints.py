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


@respx.mock
def test_export_all_returns_full_archive_as_download(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    r = client.get("/api/export", params={"channel_id": "55", "guild_id": "g1", "scope": "all"})
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert [m["id"] for m in r.json()["messages"]] == ["1", "2", "3"]


@respx.mock
def test_export_since_returns_only_last_pull(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(2), _msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(4), _msg(3)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    r = client.get("/api/export", params={"channel_id": "55", "guild_id": "g1", "scope": "since"})
    assert [m["id"] for m in r.json()["messages"]] == ["3", "4"]


@respx.mock
def test_channels_and_log_list_after_catchup(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    chans = client.get("/api/channels").json()
    assert chans == [{"id": "55", "guild_id": "g1"}]
    log = client.get("/api/log").json()
    assert log[0]["channel_id"] == "55"
    assert log[0]["fetched"] == 1


def test_export_rejects_traversal_ids(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    assert client.get("/api/export", params={"channel_id": "../state", "guild_id": "g1"}).status_code == 400
    assert client.get("/api/export", params={"channel_id": "55", "guild_id": "../etc"}).status_code == 400


def test_catchup_rejects_traversal_guild(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    r = client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "../evil"})
    assert r.status_code == 400


@respx.mock
def test_catchup_anchored_after_fetches_from_message_and_archives(tmp_path, monkeypatch):
    # An explicit `after` anchors the fetch at that message (via fetch_after),
    # regardless of any saved cursor, and still archives + returns the messages.
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    route = respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(12), _msg(11)]))
    r = client.post(
        "/api/catchup",
        json={"token": TOKEN, "channel_id": "55", "guild_id": "g1", "after": "10"},
    )
    assert r.status_code == 200
    assert route.calls.last.request.url.params.get("after") == "10"
    body = r.json()
    assert [m["id"] for m in body["messages"]] == ["11", "12"]
    assert body["appended"] == 2
    assert body["total"] == 2


@respx.mock
def test_catchup_anchored_does_not_move_cursor(tmp_path, monkeypatch):
    # An anchored capture must not disturb routine catch-up: it leaves last_seen_id
    # untouched so the next normal pull still resumes from the real cursor.
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})

    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(12), _msg(11)]))
    anchored = client.post(
        "/api/catchup",
        json={"token": TOKEN, "channel_id": "55", "guild_id": "g1", "after": "10"},
    )
    assert anchored.json()["last_seen_id"] == "3"

    route = respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    assert route.calls.last.request.url.params.get("after") == "3"


@respx.mock
def test_catchup_registers_channel_name_and_guild_name(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(200, json=[_msg(1)]))
    client.post("/api/catchup", json={
        "token": TOKEN, "channel_id": "55", "guild_id": "g1",
        "name": "general-talk", "guild_name": "Macguffins, Ltd.",
    })
    c = next(c for c in client.get("/api/channels").json() if c["id"] == "55")
    assert c["name"] == "general-talk"
    assert c["guild_name"] == "Macguffins, Ltd."


@respx.mock
def test_catchup_without_name_leaves_channel_unnamed(tmp_path, monkeypatch):
    # The backend never auto-calls Discord for the name; it only stores what the
    # client sends (the extension parses the tab title / falls back itself).
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(200, json=[_msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    c = next(c for c in client.get("/api/channels").json() if c["id"] == "55")
    assert "name" not in c


@respx.mock
def test_catchup_name_not_overwritten_by_later_unnamed_pull(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(200, json=[_msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1", "name": "general-talk"})
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(200, json=[_msg(2)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    c = next(c for c in client.get("/api/channels").json() if c["id"] == "55")
    assert c["name"] == "general-talk"


@respx.mock
def test_state_returns_last_seen_after_catchup(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(
        return_value=httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)]))
    client.post("/api/catchup", json={"token": TOKEN, "channel_id": "55", "guild_id": "g1"})
    r = client.get("/api/state", params={"channel_id": "55"})
    assert r.status_code == 200
    assert r.json()["last_seen_id"] == "3"


def test_state_unknown_channel_returns_null(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    r = client.get("/api/state", params={"channel_id": "999"})
    assert r.status_code == 200
    assert r.json()["last_seen_id"] is None


def test_state_rejects_bad_channel_id(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    assert client.get("/api/state", params={"channel_id": "../x"}).status_code == 400


@respx.mock
def test_catchup_rejects_non_snowflake_after(tmp_path, monkeypatch):
    monkeypatch.setenv("LURK_DATA_DIR", str(tmp_path))
    respx.get(f"{API}/channels/55/messages").mock(return_value=httpx.Response(200, json=[]))
    r = client.post(
        "/api/catchup",
        json={"token": TOKEN, "channel_id": "55", "guild_id": "g1", "after": "not-a-number"},
    )
    assert r.status_code == 400
