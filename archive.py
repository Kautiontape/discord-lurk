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
