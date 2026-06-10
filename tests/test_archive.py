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
