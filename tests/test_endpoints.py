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
