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
