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
