# lurk Catch-up Backend & Consent UI — Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the lurk FastAPI app with a server-side catch-up path — clean Discord messages into a per-channel on-disk archive, fetch only what's new since a last-seen pointer, export an LLM-ready JSON document, and surface a prominent Discord-ToS consent gate plus a transparency log.

**Architecture:** Split the monolithic `app.py` into focused modules (`discord_api.py` for the Discord client, `clean.py` for the message transform, `archive.py` for on-disk storage). Add two endpoints — `POST /api/catchup` (fetch-since-marker → clean → append → advance pointer) and `GET /api/export` (consolidate archive into one JSON document) — plus `/api/channels` and `/api/log`. Add CORS scoped to the extension + localhost so Plan B's extension can POST. The web UI gains a first-run ToS consent modal, a persistent banner, and a transparency-log panel. State and archive live under a gitignored `data/` dir on whichever host runs the app. The token is used per-request and never written to disk.

**Tech Stack:** Python 3.12, FastAPI 0.115, httpx 0.28 (async), pytest + pytest-asyncio + respx for tests, vanilla JS/HTML/CSS frontend (no build step).

**Scope note:** This is Plan A of two. Plan B (the browser capture extension) is authored separately and depends on this plan's `POST /api/catchup` contract. This plan is fully usable on its own: `/api/catchup` can be driven by curl or any HTTP client.

**Resolved open items from the spec:**
- First-ever-pull backfill = most recent **200** messages (env `LURK_BACKFILL_LIMIT`, default 200).
- Data directory = `data/` (env `LURK_DATA_DIR`, default `data`).
- Browser target for the extension (Plan B) = Chrome MV3 — not relevant to this plan.

---

## File Structure

**New modules (repo root, flat — keeps `uvicorn app:app` entrypoint intact):**
- `discord_api.py` — Discord REST client: error mapping, `get_channel`, `fetch_after`, `fetch_recent`. Owns the `DISCORD_API`, `SNOWFLAKE_RE`, `TOKEN_RE` constants (moved from `app.py`).
- `clean.py` — pure transform `clean_message(raw, thread=None) -> dict`. No I/O, no HTTP.
- `archive.py` — on-disk storage: archive append/read (JSONL, deduped), state pointers, saved-channels registry, transparency log. Every function takes a base `Path`.

**Modified:**
- `app.py` — import the new modules; refactor existing `/api/messages` + `/api/channel` to use `discord_api`; add `/api/catchup`, `/api/export`, `/api/channels`, `/api/log`; add CORS middleware.
- `static/index.html` — consent modal + persistent banner + transparency-log panel.
- `Dockerfile` — copy the new modules; declare the data dir.
- `docker-compose.yml` — mount `./data:/app/data`, set `LURK_DATA_DIR`.
- `.gitignore`, `.dockerignore` — ignore `data/` (and `tests/`, `.pytest_cache/` from the image).
- `README.md` — document the new endpoints, the data dir, and how to run tests.

**New test files:**
- `tests/test_clean.py`, `tests/test_archive.py`, `tests/test_discord_api.py`, `tests/test_endpoints.py`
- `requirements-dev.txt`, `pytest.ini`

**On-disk data layout (created at runtime, gitignored):**
```
data/
  archives/<guild_id>/<channel_id>.jsonl   # cleaned messages, append-only, deduped by id
  state.json                               # { "channels": { "<id>": {last_seen_id, last_pull_first_id, last_pull_at} } }
  channels.json                            # [ {id, guild_id, name?, guild_name?} ]  saved/registered channels
  log.jsonl                                # one transparency entry per catchup
```

---

## Task 0: Test scaffolding

**Files:**
- Create: `requirements-dev.txt`
- Create: `pytest.ini`
- Create: `tests/__init__.py`

- [ ] **Step 1: Create dev requirements**

`requirements-dev.txt`:
```
-r requirements.txt
pytest==8.3.4
pytest-asyncio==0.25.0
respx==0.22.0
```

- [ ] **Step 2: Create pytest config**

`pytest.ini`:
```ini
[pytest]
asyncio_mode = auto
testpaths = tests
```

- [ ] **Step 3: Create the tests package marker**

`tests/__init__.py`: (empty file)

- [ ] **Step 4: Install and verify the runner works**

Run: `pip install -r requirements-dev.txt && python -m pytest -q`
Expected: `no tests ran` (exit code 5) — the runner is installed and finds the empty `tests/` dir.

- [ ] **Step 5: Commit**

```bash
git add requirements-dev.txt pytest.ini tests/__init__.py
git commit -m "test: add pytest + respx scaffolding"
```

---

## Task 1: `clean.py` — message transform

**Files:**
- Create: `clean.py`
- Test: `tests/test_clean.py`

- [ ] **Step 1: Write the failing tests**

`tests/test_clean.py`:
```python
from clean import clean_message


def _raw(**over):
    base = {
        "id": "1002",
        "timestamp": "2026-06-09T20:42:00.000000+00:00",
        "content": "hello",
        "author": {"id": "7", "username": "alice", "global_name": "Alice"},
        "mentions": [],
        "attachments": [],
        "embeds": [],
    }
    base.update(over)
    return base


def test_basic_shape():
    out = clean_message(_raw())
    assert out["id"] == "1002"
    assert out["ts"] == "2026-06-09T20:42:00.000000+00:00"
    assert out["author"] == {"id": "7", "name": "Alice", "bot": False}
    assert out["content"] == "hello"
    assert out["reply_to"] is None
    assert out["thread"] is None
    assert out["attachments"] == []
    assert out["embeds"] == []


def test_author_falls_back_to_username_then_bot_flag():
    out = clean_message(_raw(author={"id": "9", "username": "dicebot", "bot": True}))
    assert out["author"] == {"id": "9", "name": "dicebot", "bot": True}


def test_resolves_user_and_channel_mentions():
    raw = _raw(
        content="hey <@7> see <#55> and <@!7>",
        mentions=[{"id": "7", "global_name": "Alice", "username": "alice"}],
        mention_channels=[{"id": "55", "name": "general"}],
    )
    out = clean_message(raw)
    assert out["content"] == "hey @Alice see #general and @Alice"


def test_unresolved_mention_keeps_id():
    out = clean_message(_raw(content="ping <@999>"))
    assert out["content"] == "ping @999"


def test_reply_to_from_message_reference():
    out = clean_message(_raw(message_reference={"message_id": "1001"}))
    assert out["reply_to"] == "1001"


def test_attachments_and_embeds_are_trimmed():
    raw = _raw(
        attachments=[{"filename": "map.png", "url": "https://cdn/x", "size": 1234}],
        embeds=[{"title": "Avrae", "description": "Attack: 18",
                 "fields": [{"name": "d20", "value": "18", "inline": True}], "color": 5}],
    )
    out = clean_message(raw)
    assert out["attachments"] == [{"filename": "map.png", "url": "https://cdn/x"}]
    assert out["embeds"] == [{"title": "Avrae", "description": "Attack: 18",
                              "fields": [{"name": "d20", "value": "18"}]}]


def test_thread_passed_through():
    out = clean_message(_raw(), thread={"id": "300", "name": "The Crypt"})
    assert out["thread"] == {"id": "300", "name": "The Crypt"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_clean.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'clean'`.

- [ ] **Step 3: Implement `clean.py`**

`clean.py`:
```python
import re

_MENTION_RE = re.compile(r"<@!?(\d+)>")
_CHANNEL_MENTION_RE = re.compile(r"<#(\d+)>")


def _author_name(author: dict) -> str:
    return author.get("global_name") or author.get("username") or author.get("id", "unknown")


def _resolve_mentions(content: str, mentions: list, mention_channels: list) -> str:
    by_id = {m["id"]: _author_name(m) for m in mentions}
    content = _MENTION_RE.sub(lambda mt: "@" + by_id.get(mt.group(1), mt.group(1)), content)
    ch_by_id = {c["id"]: c.get("name", c["id"]) for c in mention_channels}
    content = _CHANNEL_MENTION_RE.sub(lambda mt: "#" + ch_by_id.get(mt.group(1), mt.group(1)), content)
    return content


def _clean_embed(embed: dict) -> dict:
    return {
        "title": embed.get("title"),
        "description": embed.get("description"),
        "fields": [
            {"name": f.get("name"), "value": f.get("value")}
            for f in embed.get("fields", [])
        ],
    }


def clean_message(raw: dict, thread: dict | None = None) -> dict:
    author = raw.get("author", {})
    content = _resolve_mentions(
        raw.get("content", ""),
        raw.get("mentions", []),
        raw.get("mention_channels", []),
    )
    ref = raw.get("message_reference") or {}
    return {
        "id": raw["id"],
        "ts": raw.get("timestamp"),
        "author": {
            "id": author.get("id"),
            "name": _author_name(author),
            "bot": bool(author.get("bot", False)),
        },
        "content": content,
        "reply_to": ref.get("message_id"),
        "thread": thread,
        "attachments": [
            {"filename": a.get("filename"), "url": a.get("url")}
            for a in raw.get("attachments", [])
        ],
        "embeds": [_clean_embed(e) for e in raw.get("embeds", [])],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_clean.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add clean.py tests/test_clean.py
git commit -m "feat: add Discord message cleaning transform"
```

---

## Task 2: `archive.py` — archive append/read with dedup

**Files:**
- Create: `archive.py`
- Test: `tests/test_archive.py`

- [ ] **Step 1: Write the failing tests**

`tests/test_archive.py`:
```python
from pathlib import Path

import archive


def test_read_missing_archive_returns_empty(tmp_path: Path):
    assert archive.read_archive(tmp_path, "g1", "c1") == []


def test_append_then_read_roundtrip(tmp_path: Path):
    msgs = [{"id": "1", "content": "a"}, {"id": "2", "content": "b"}]
    added = archive.append_messages(tmp_path, "g1", "c1", msgs)
    assert added == 2
    assert archive.read_archive(tmp_path, "g1", "c1") == msgs


def test_append_dedupes_by_id(tmp_path: Path):
    archive.append_messages(tmp_path, "g1", "c1", [{"id": "1", "content": "a"}])
    added = archive.append_messages(
        tmp_path, "g1", "c1",
        [{"id": "1", "content": "a"}, {"id": "2", "content": "b"}],
    )
    assert added == 1
    ids = [m["id"] for m in archive.read_archive(tmp_path, "g1", "c1")]
    assert ids == ["1", "2"]


def test_archives_are_isolated_per_channel(tmp_path: Path):
    archive.append_messages(tmp_path, "g1", "c1", [{"id": "1"}])
    archive.append_messages(tmp_path, "g1", "c2", [{"id": "9"}])
    assert [m["id"] for m in archive.read_archive(tmp_path, "g1", "c1")] == ["1"]
    assert [m["id"] for m in archive.read_archive(tmp_path, "g1", "c2")] == ["9"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_archive.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'archive'`.

- [ ] **Step 3: Implement the archive portion of `archive.py`**

`archive.py`:
```python
import json
import os
from pathlib import Path


def data_dir() -> Path:
    return Path(os.environ.get("LURK_DATA_DIR", "data"))


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def archive_path(base: Path, guild_id: str, channel_id: str) -> Path:
    return base / "archives" / guild_id / f"{channel_id}.jsonl"


def read_archive(base: Path, guild_id: str, channel_id: str) -> list:
    path = archive_path(base, guild_id, channel_id)
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def append_messages(base: Path, guild_id: str, channel_id: str, messages: list) -> int:
    existing = {m["id"] for m in read_archive(base, guild_id, channel_id)}
    new = [m for m in messages if m["id"] not in existing]
    if not new:
        return 0
    path = archive_path(base, guild_id, channel_id)
    _ensure_parent(path)
    with path.open("a") as f:
        for m in new:
            f.write(json.dumps(m) + "\n")
    return len(new)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_archive.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add archive.py tests/test_archive.py
git commit -m "feat: add per-channel JSONL archive with dedup"
```

---

## Task 3: `archive.py` — state pointers, channel registry, transparency log

**Files:**
- Modify: `archive.py`
- Test: `tests/test_archive.py`

- [ ] **Step 1: Add the failing tests**

Append to `tests/test_archive.py`:
```python
def test_last_seen_absent_then_set(tmp_path: Path):
    assert archive.get_last_seen(tmp_path, "c1") is None
    archive.update_pull(tmp_path, "c1", last_seen_id="50", first_added_id="40", when="2026-06-10T00:00:00Z")
    assert archive.get_last_seen(tmp_path, "c1") == "50"


def test_update_pull_records_first_added_and_time(tmp_path: Path):
    archive.update_pull(tmp_path, "c1", last_seen_id="50", first_added_id="40", when="2026-06-10T00:00:00Z")
    state = archive.load_state(tmp_path)["channels"]["c1"]
    assert state == {"last_seen_id": "50", "last_pull_first_id": "40", "last_pull_at": "2026-06-10T00:00:00Z"}


def test_register_channel_is_idempotent_and_updates_names(tmp_path: Path):
    archive.register_channel(tmp_path, {"id": "c1", "guild_id": "g1"})
    archive.register_channel(tmp_path, {"id": "c1", "guild_id": "g1", "name": "the-crypt"})
    chans = archive.list_channels(tmp_path)
    assert chans == [{"id": "c1", "guild_id": "g1", "name": "the-crypt"}]


def test_log_appends_and_reads_newest_first(tmp_path: Path):
    archive.append_log(tmp_path, {"at": "t1", "channel_id": "c1", "fetched": 3})
    archive.append_log(tmp_path, {"at": "t2", "channel_id": "c1", "fetched": 0})
    log = archive.read_log(tmp_path, limit=10)
    assert [e["at"] for e in log] == ["t2", "t1"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_archive.py -q`
Expected: FAIL with `AttributeError: module 'archive' has no attribute 'get_last_seen'`.

- [ ] **Step 3: Implement state, registry, and log in `archive.py`**

Append to `archive.py`:
```python
def _state_path(base: Path) -> Path:
    return base / "state.json"


def load_state(base: Path) -> dict:
    p = _state_path(base)
    if not p.exists():
        return {"channels": {}}
    return json.loads(p.read_text())


def save_state(base: Path, state: dict) -> None:
    p = _state_path(base)
    _ensure_parent(p)
    p.write_text(json.dumps(state, indent=2))


def get_last_seen(base: Path, channel_id: str):
    return load_state(base)["channels"].get(channel_id, {}).get("last_seen_id")


def update_pull(base: Path, channel_id: str, last_seen_id: str, first_added_id, when: str) -> None:
    state = load_state(base)
    state["channels"][channel_id] = {
        "last_seen_id": last_seen_id,
        "last_pull_first_id": first_added_id,
        "last_pull_at": when,
    }
    save_state(base, state)


def _channels_path(base: Path) -> Path:
    return base / "channels.json"


def list_channels(base: Path) -> list:
    p = _channels_path(base)
    if not p.exists():
        return []
    return json.loads(p.read_text())


def register_channel(base: Path, channel: dict) -> None:
    chans = list_channels(base)
    for c in chans:
        if c["id"] == channel["id"]:
            c.update(channel)
            break
    else:
        chans.append(channel)
    p = _channels_path(base)
    _ensure_parent(p)
    p.write_text(json.dumps(chans, indent=2))


def _log_path(base: Path) -> Path:
    return base / "log.jsonl"


def append_log(base: Path, entry: dict) -> None:
    p = _log_path(base)
    _ensure_parent(p)
    with p.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def read_log(base: Path, limit: int = 50) -> list:
    p = _log_path(base)
    if not p.exists():
        return []
    lines = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    return lines[-limit:][::-1]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_archive.py -q`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add archive.py tests/test_archive.py
git commit -m "feat: add state pointers, channel registry, transparency log"
```

---

## Task 4: `discord_api.py` — Discord client

**Files:**
- Create: `discord_api.py`
- Test: `tests/test_discord_api.py`

- [ ] **Step 1: Write the failing tests**

`tests/test_discord_api.py`:
```python
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
async def test_fetch_after_paginates_and_sorts_ascending():
    # Discord returns newest-first; two pages then empty.
    route = respx.get(f"{API}/channels/c1/messages")
    route.side_effect = [
        httpx.Response(200, json=[_msg(105), _msg(104), _msg(103)]),
        httpx.Response(200, json=[_msg(102), _msg(101)]),  # < 100 → stop
    ]
    out = await discord_api.fetch_after("tok", "c1", after="100")
    assert [m["id"] for m in out] == ["101", "102", "103", "104", "105"]


@respx.mock
async def test_fetch_recent_returns_last_n_ascending():
    route = respx.get(f"{API}/channels/c1/messages")
    route.side_effect = [httpx.Response(200, json=[_msg(3), _msg(2), _msg(1)])]
    out = await discord_api.fetch_recent("tok", "c1", limit=2)
    assert [m["id"] for m in out] == ["2", "3"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_discord_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'discord_api'`.

- [ ] **Step 3: Implement `discord_api.py`**

`discord_api.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_discord_api.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add discord_api.py tests/test_discord_api.py
git commit -m "feat: add Discord API client module with pagination"
```

---

## Task 5: Refactor `app.py` onto the new modules + add CORS

**Files:**
- Modify: `app.py:1-97` (full rewrite of imports, validation, existing endpoints; add CORS)

- [ ] **Step 1: Rewrite `app.py` to use `discord_api`, keep existing endpoints, add CORS**

Replace the entire contents of `app.py` with:
```python
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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


app.mount("/", StaticFiles(directory="static", html=True), name="static")
```

- [ ] **Step 2: Add a smoke test for the existing endpoints + CORS**

`tests/test_endpoints.py`:
```python
import httpx
import respx
from fastapi.testclient import TestClient

import app as app_module

API = "https://discord.com/api/v10"
client = TestClient(app_module.app)
TOKEN = "abcdefghijklmnopqrstuvwxyz123"


def test_messages_rejects_malformed_token():
    r = client.post("/api/messages", json={"token": "tok!!!short", "channel_id": "1"})
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
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `python -m pytest tests/test_endpoints.py -q`
Expected: PASS (3 passed). (The malformed-token test needs no network; the channel test is mocked.)

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest -q`
Expected: PASS (all tasks 1-5 green).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_endpoints.py
git commit -m "refactor: move Discord client into module, add CORS"
```

---

## Task 6: `POST /api/catchup`

**Files:**
- Modify: `app.py` (add import block, `CatchupRequest`, `backfill_limit`, the endpoint — above `app.mount`)
- Test: `tests/test_endpoints.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_endpoints.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_endpoints.py -k catchup -q`
Expected: FAIL with 404 (route not defined) / KeyError.

- [ ] **Step 3: Implement the catchup endpoint**

In `app.py`, add to the imports at the top:
```python
import os
from datetime import datetime, timezone

import archive
import clean
```

Add the request model near the other models:
```python
class CatchupRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel_id: str = Field(min_length=1, max_length=30)
    guild_id: str = Field(default="dm", max_length=30)


def backfill_limit() -> int:
    return int(os.environ.get("LURK_BACKFILL_LIMIT", "200"))
```

Add the endpoint **above** `app.mount(...)`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_endpoints.py -k catchup -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_endpoints.py
git commit -m "feat: add /api/catchup server-side fetch-clean-archive path"
```

---

## Task 7: `GET /api/export`, `/api/channels`, `/api/log`

**Files:**
- Modify: `app.py` (add three GET endpoints above `app.mount`)
- Test: `tests/test_endpoints.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_endpoints.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_endpoints.py -k "export or channels_and_log" -q`
Expected: FAIL with 404 (routes not defined).

- [ ] **Step 3: Implement the three GET endpoints**

In `app.py`, add `import json` to the top imports, then add **above** `app.mount(...)`:
```python
from fastapi.responses import Response


@app.get("/api/export")
async def export(channel_id: str, guild_id: str = "dm", scope: str = "all"):
    base = archive.data_dir()
    messages = archive.read_archive(base, guild_id, channel_id)
    if scope == "since":
        marker = archive.load_state(base)["channels"].get(channel_id, {}).get("last_pull_first_id")
        if marker is not None:
            messages = [m for m in messages if int(m["id"]) >= int(marker)]
    payload = json.dumps(
        {"channel_id": channel_id, "guild_id": guild_id, "messages": messages},
        indent=2,
    )
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="lurk-{channel_id}.json"'},
    )


@app.get("/api/channels")
async def channels():
    return archive.list_channels(archive.data_dir())


@app.get("/api/log")
async def log(limit: int = 50):
    return archive.read_log(archive.data_dir(), limit=limit)
```

Note: put the `from fastapi.responses import Response` line with the other top-of-file imports rather than inline; shown here next to its use for clarity.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest -q`
Expected: PASS (full suite green).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_endpoints.py
git commit -m "feat: add /api/export, /api/channels, /api/log endpoints"
```

---

## Task 8: Consent gate — ToS modal + persistent banner

**Files:**
- Modify: `static/index.html` (add modal markup + banner near top of `.page`; CSS in the `<style>` block; JS in the `<script>` block near `// ---- init ----`)

This task has no JS test harness in the project, so verification is manual with exact expected behavior.

- [ ] **Step 1: Add modal + banner CSS**

In the `<style>` block (before the closing `</style>`), add:
```css
.consent-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.78);
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
}
.consent-card {
  background: var(--bg-card); border: 1px solid var(--red);
  border-radius: 8px; padding: 1.75rem; max-width: 540px;
}
.consent-card h2 {
  font-family: var(--mono); color: var(--red);
  font-size: 1rem; margin-bottom: 1rem; letter-spacing: 0.02em;
}
.consent-card p { font-size: 0.9rem; margin-bottom: 0.9rem; }
.consent-card .ack { display: flex; gap: 0.6rem; align-items: flex-start; margin: 1.1rem 0; }
.consent-card .ack input { margin-top: 0.2rem; }
.consent-banner {
  background: rgba(255,82,82,0.08); border: 1px solid rgba(255,82,82,0.3);
  border-radius: 6px; padding: 0.6rem 0.85rem; margin-bottom: 1.25rem;
  font-family: var(--mono); font-size: 0.72rem; color: var(--red);
}
```

- [ ] **Step 2: Add modal + banner markup**

Immediately inside `<div class="page">` (before `<header>`), add the banner:
```html
<div id="consent-banner" class="consent-banner hidden">
  ⚠ using a user token is a self-bot — against Discord's ToS and can get your account banned. lurk runs on your own host and never stores the token.
</div>
```

At the end of `<div class="page">` (just before its closing `</div>`), add the modal:
```html
<div id="consent-overlay" class="consent-overlay hidden">
  <div class="consent-card">
    <h2>read this before you continue</h2>
    <p>lurk reads Discord with <strong>your own user token</strong>. Automating a user account this way is a "self-bot," which <strong>violates Discord's Terms of Service and can get your account banned.</strong></p>
    <p>lurk runs on the host you point it at (your machine or your own server). Your token is used only to fetch messages and is <strong>never written to disk</strong>. Exported messages are stored locally so you can hand them to an LLM yourself.</p>
    <label class="ack">
      <input type="checkbox" id="consent-check">
      <span>I understand this risks my Discord account and I accept that risk.</span>
    </label>
    <button class="btn primary" id="consent-accept" disabled>I understand — continue</button>
  </div>
</div>
```

- [ ] **Step 3: Add consent JS**

In the `<script>` block, just above the `// ---- init ----` comment, add:
```javascript
const CONSENT_KEY = 'lurk.consent.v1';
function renderConsent() {
  const accepted = localStorage.getItem(CONSENT_KEY) === '1';
  $('consent-overlay').classList.toggle('hidden', accepted);
  $('consent-banner').classList.toggle('hidden', !accepted);
}
$('consent-check').addEventListener('change', (e) => {
  $('consent-accept').disabled = !e.target.checked;
});
$('consent-accept').addEventListener('click', () => {
  localStorage.setItem(CONSENT_KEY, '1');
  renderConsent();
});
```

Then add `renderConsent();` to the init block (next to `renderTokenSection();`).

- [ ] **Step 4: Manual verification**

Run: `LURK_DATA_DIR=$(mktemp -d) uvicorn app:app --port 8000` and open `http://127.0.0.1:8000` in a fresh private window.
Expected:
1. The ToS modal blocks the page on first load; the "continue" button is disabled.
2. Ticking the checkbox enables the button; clicking it dismisses the modal and reveals the red banner.
3. Reloading the page keeps the modal dismissed and the banner visible (consent persisted in localStorage).

- [ ] **Step 5: Commit**

```bash
git add static/index.html
git commit -m "feat: add Discord-ToS consent modal and persistent banner"
```

---

## Task 9: Transparency-log panel

**Files:**
- Modify: `static/index.html` (add a `<section>` for the log; JS to fetch `/api/log` and render)

- [ ] **Step 1: Add the log section markup**

After the `channels-section` `</section>`, add:
```html
<section id="log-section">
  <h2><span>transparency log</span>
    <button class="btn subtle" id="refresh-log" style="margin-left:auto;">refresh</button>
  </h2>
  <div id="log-list" class="empty-state">no pulls recorded yet.</div>
</section>
```

- [ ] **Step 2: Add the log-render JS**

In the `<script>` block, above `// ---- init ----`, add:
```javascript
async function renderLog() {
  const box = $('log-list');
  try {
    const res = await fetch('/api/log?limit=20');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    if (!entries.length) { box.className = 'empty-state'; box.textContent = 'no pulls recorded yet.'; return; }
    box.className = '';
    box.innerHTML = entries.map((e) =>
      `<div class="channel-history">${new Date(e.at).toLocaleString()} · channel ${e.channel_id} · `
      + `fetched ${e.fetched}, added ${e.appended}</div>`).join('');
  } catch (err) {
    box.className = 'empty-state';
    box.textContent = `log unavailable: ${err.message}`;
  }
}
$('refresh-log').addEventListener('click', renderLog);
```

Then add `renderLog();` to the init block.

- [ ] **Step 3: Manual verification**

With the server running (data dir from Task 8), trigger a pull so the log has an entry:
```bash
curl -s -X POST http://127.0.0.1:8000/api/catchup \
  -H 'Content-Type: application/json' \
  -d '{"token":"<a-real-or-fake-20+char-token>","channel_id":"<id>","guild_id":"g1"}' >/dev/null
```
(If using a fake token the call returns a Discord error and logs nothing — to see a row, point at a channel a real token can read, or pre-seed `data/log.jsonl` with one JSON line.)
Open the page and click **refresh** in the transparency-log section.
Expected: the most recent pull appears as a row showing timestamp, channel id, and fetched/added counts.

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "feat: add transparency-log panel to the web UI"
```

---

## Task 10: Deployment plumbing — data volume, Docker, ignores

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.gitignore`
- Modify: `.dockerignore`

- [ ] **Step 1: Update `.gitignore`**

Append to `.gitignore`:
```
data/
.pytest_cache/
```

- [ ] **Step 2: Update `.dockerignore`**

Append to `.dockerignore`:
```
data
tests
.pytest_cache
docs
*.md
```

- [ ] **Step 3: Update the `Dockerfile` to copy new modules and declare the data dir**

Replace the `COPY app.py .` line with copies of all runtime modules, and add a data dir. The full `Dockerfile`:
```dockerfile
FROM python:3.12-alpine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py clean.py archive.py discord_api.py ./
COPY static ./static

ENV PYTHONUNBUFFERED=1
ENV LURK_DATA_DIR=/app/data
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Update `docker-compose.yml` to persist the data dir**

Full `docker-compose.yml`:
```yaml
services:
  app:
    build: .
    container_name: discord-lurk
    ports:
      - "127.0.0.1:8111:8000"
    volumes:
      - ./data:/app/data
    environment:
      - LURK_DATA_DIR=/app/data
    restart: always
```

- [ ] **Step 5: Verify the image builds and serves**

Run: `docker compose build && docker compose up -d && sleep 2 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8111/ && docker compose down`
Expected: build succeeds; curl prints `200`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .gitignore .dockerignore
git commit -m "build: persist data dir, copy new modules into image"
```

---

## Task 11: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the new endpoints, data dir, and tests**

Replace the `## Endpoints` section of `README.md` with:
```markdown
## Endpoints

- `POST /api/channel` — channel metadata for a token + channel ID
- `POST /api/messages` — raw messages for a channel (`after`/`before`/`limit`)
- `POST /api/catchup` — fetch new messages since the last pull, clean them, append
  to the per-channel archive, advance the last-seen pointer. Body:
  `{ token, channel_id, guild_id }`. Returns the cleaned new slice + counts.
- `GET /api/export?channel_id=&guild_id=&scope=all|since` — the archive as one
  downloadable JSON document (`since` = only the most recent pull).
- `GET /api/channels` — registered channels. `GET /api/log` — transparency log.

## Data

Archives and state live under `data/` (override with `LURK_DATA_DIR`):
`data/archives/<guild>/<channel>.jsonl`, `data/state.json`, `data/channels.json`,
`data/log.jsonl`. The Discord token is used per-request and never written to disk.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```
```

- [ ] **Step 2: Verify the full suite once more**

Run: `python -m pytest -q`
Expected: PASS (entire suite green).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document catchup/export endpoints and data dir"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-09-lurk-local-catchup-design.md`):
- Cleaned message shape → Task 1 (`clean.py`).
- Per-channel JSONL archive, deduped → Task 2.
- Last-seen state, channel registry, transparency log → Task 3.
- Discord client + pagination + first-pull backfill → Task 4.
- `/api/catchup` (fetch-since → clean → append → advance → log) → Task 6.
- `/api/export` (all / since), channels, log endpoints → Task 7.
- Token never written to disk → only forwarded in `discord_api`; never passed to `archive` (verified by inspection — no archive function receives the token).
- Consent gate (modal + persistent banner, ToS/ban focus) → Task 8.
- Transparency log surfaced in UI → Task 9.
- CORS scoped to extension + localhost → Task 5.
- Data dir on host, env-configurable, persisted in Docker → Tasks 3/10.
- Existing `/api/messages` + `/api/channel` retained → Task 5.

**Out of scope (correctly absent):** in-app LLM summaries; redaction/anonymization; multi-user. The browser extension is Plan B (separate plan) — its `/api/catchup` contract is fixed here.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `clean_message(raw, thread=None)`, `append_messages(base, guild_id, channel_id, messages)`, `get_last_seen(base, channel_id)`, `update_pull(base, channel_id, last_seen_id, first_added_id, when)`, `fetch_after(token, channel_id, after)`, `fetch_recent(token, channel_id, limit)` — names and signatures are used identically across tasks 1-7. `last_pull_first_id` (state) is the marker `/api/export?scope=since` filters on (Task 3 writes it, Task 7 reads it).
