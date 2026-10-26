#!/usr/bin/env python3
"""Copy a stopped TuneDrop SQLite database to an empty MySQL database."""
import argparse
import os
import sqlite3
from pathlib import Path

from runtime_config import load_environment


TABLES = ('users', 'playlists', 'bookmarks', 'public_favorites', 'analysis_cache', 'site_settings')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sqlite', default=None,
                        help='移行元 SQLite のパス (既定: TUNEDROP_DB / プロジェクト直下の database.sqlite)')
    parser.add_argument('--apply', action='store_true', help='write to the configured empty MySQL database')
    args = parser.parse_args()
    load_environment()
    if not args.sqlite:
        # DB を配信フォルダの外に置く運用 (TUNEDROP_DB) にも追随する
        args.sqlite = os.environ.get('TUNEDROP_DB') or str(Path(__file__).with_name('database.sqlite'))
    import mysql_db
    if not mysql_db.enabled():
        parser.error('set TUNEDROP_MYSQL_HOST, USER, PASSWORD, DATABASE in .env first')
    source = sqlite3.connect(f'file:{Path(args.sqlite).resolve()}?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    target = mysql_db.connect()
    try:
        counts = {}
        for table in TABLES:
            exists = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            counts[table] = source.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] if exists else 0
            if target.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]:
                raise RuntimeError(f'MySQL table {table} is not empty; refusing to overwrite it')
        print('SQLite rows:', counts)
        if not args.apply:
            print('Dry run only. Stop PHP/Python writes and rerun with --apply.')
            return
        for table in TABLES:
            if not counts[table]:
                continue
            source_cols = [row[1] for row in source.execute(f'PRAGMA table_info({table})')]
            target_cols = [row['Field'] for row in target.execute(f'SHOW COLUMNS FROM {table}').fetchall()]
            cols = [col for col in source_cols if col in target_cols]
            quoted = ', '.join(f'`{col}`' for col in cols)
            marks = ', '.join(['?'] * len(cols))
            select = source.execute(f'SELECT {quoted} FROM {table}')
            for row in select:
                target.execute(f'INSERT INTO {table} ({quoted}) VALUES ({marks})', tuple(row))
            print(f'{table}: {counts[table]} rows')
        for table, expected in counts.items():
            actual = target.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            if actual != expected:
                raise RuntimeError(f'{table}: expected {expected} rows, got {actual}')
        target.commit()
        print('Copy complete. Compare counts, then set TUNEDROP_MYSQL_HOST in the PHP and Python environments.')
    except Exception:
        target.rollback()
        raise
    finally:
        target.close()
        source.close()


if __name__ == '__main__':
    main()
