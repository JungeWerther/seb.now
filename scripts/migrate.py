"""Apply pending supabase/migrations/*.sql to the database, oldest first.

Run by CI on every push to the `migrations` branch, after the tests. The
frontend deploys from main, so landing a schema change on `migrations` first
means a page never ships ahead of the schema it needs. Each file runs in
its own transaction together with its row in supabase_migrations.schema_migrations
(version = the file's timestamp prefix, name = the rest), so a failing
migration leaves nothing behind and fails the run.

    SUPABASE_DB_URL=postgresql://… python scripts/migrate.py [--dry-run]

A migration counts as applied when its version is in schema_migrations.
"""

import os
import re
import sys
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
MIGRATION_FILE = re.compile(r"^(\d{14})_([a-z0-9_]+)\.sql$")


def migration_files(directory: Path = MIGRATIONS_DIR) -> list[tuple[str, str, Path]]:
    """(version, name, path) for every migration file, oldest first."""
    found = []
    for path in sorted(directory.glob("*.sql")):
        match = MIGRATION_FILE.match(path.name)
        if not match:
            raise SystemExit(f"{path.name}: migration files are named <14-digit version>_<snake_name>.sql")
        found.append((match.group(1), match.group(2), path))
    versions = [version for version, _, _ in found]
    duplicates = sorted({v for v in versions if versions.count(v) > 1})
    if duplicates:
        raise SystemExit(f"two migration files share a version: {', '.join(duplicates)}")
    return found


def pending(files: list[tuple[str, str, Path]], applied: set[str]) -> list[tuple[str, str, Path]]:
    """The files whose version the database hasn't recorded, in order."""
    return [entry for entry in files if entry[0] not in applied]


def main() -> None:
    import psycopg

    dry_run = "--dry-run" in sys.argv[1:]
    files = migration_files()
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True) as conn:
        applied = {row[0] for row in conn.execute("select version from supabase_migrations.schema_migrations")}
        todo = pending(files, applied)
        if not todo:
            print("No pending migrations.")
            return
        for version, name, path in todo:
            print(f"{'Would apply' if dry_run else 'Applying'} {path.name}")
            if dry_run:
                continue
            with conn.transaction():
                # No parameters, so psycopg sends the file as one simple query and
                # several statements (and $$-quoted bodies) run as written.
                conn.execute(path.read_text())
                conn.execute(
                    "insert into supabase_migrations.schema_migrations (version, name) values (%s, %s)",
                    (version, name),
                )
        print(f"{'Would apply' if dry_run else 'Applied'} {len(todo)} migration(s).")


if __name__ == "__main__":
    main()
