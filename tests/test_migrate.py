import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "migrate.py"
spec = importlib.util.spec_from_file_location("migrate", SCRIPT)
migrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate)


def test_repo_migrations_are_well_named_with_unique_versions() -> None:
    # Fails CI before merge if two files share a version (CI applies by version).
    files = migrate.migration_files()
    assert files
    assert [version for version, _, _ in files] == sorted(version for version, _, _ in files)


def test_pending_keeps_unapplied_files_in_order(tmp_path: Path) -> None:
    for name in ["20260101000000_a.sql", "20260102000000_b.sql", "20260103000000_c.sql"]:
        (tmp_path / name).write_text("select 1;")
    files = migrate.migration_files(tmp_path)
    todo = migrate.pending(files, {"20260102000000"})
    assert [(v, n) for v, n, _ in todo] == [("20260101000000", "a"), ("20260103000000", "c")]


def test_duplicate_versions_are_refused(tmp_path: Path) -> None:
    (tmp_path / "20260101000000_a.sql").write_text("select 1;")
    (tmp_path / "20260101000000_b.sql").write_text("select 1;")
    with pytest.raises(SystemExit, match="share a version"):
        migrate.migration_files(tmp_path)


def test_badly_named_files_are_refused(tmp_path: Path) -> None:
    (tmp_path / "add-things.sql").write_text("select 1;")
    with pytest.raises(SystemExit, match="named"):
        migrate.migration_files(tmp_path)
