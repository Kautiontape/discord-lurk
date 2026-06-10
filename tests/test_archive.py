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
