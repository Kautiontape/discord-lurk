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
