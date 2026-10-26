"""Small MySQL adapter for the existing sqlite3-style Python call sites."""
import os
import sqlite3
from datetime import date, datetime

try:
    import pymysql
    IntegrityError = pymysql.err.IntegrityError
except ImportError:
    IntegrityError = sqlite3.IntegrityError


_environment_loaded = False


def enabled():
    global _environment_loaded
    if not _environment_loaded:
        from runtime_config import load_environment
        load_environment()
        _environment_loaded = True
    return bool(os.environ.get('TUNEDROP_MYSQL_HOST'))


def options():
    return dict(
        host=os.environ['TUNEDROP_MYSQL_HOST'],
        port=int(os.environ.get('TUNEDROP_MYSQL_PORT', '3306')),
        user=os.environ['TUNEDROP_MYSQL_USER'],
        password=os.environ.get('TUNEDROP_MYSQL_PASSWORD', ''),
        database=os.environ['TUNEDROP_MYSQL_DATABASE'],
        charset='utf8mb4',
        connect_timeout=5,
        read_timeout=15,
        write_timeout=15,
        autocommit=False,
    )


class Row(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)

    def __iter__(self):
        return iter(self.values())


class Cursor:
    def __init__(self, connection):
        import pymysql
        self.raw = connection.raw.cursor(pymysql.cursors.DictCursor)

    def execute(self, sql, args=None):
        self.raw.execute(sql.replace('?', '%s'), args)
        return self

    def fetchone(self):
        row = self.raw.fetchone()
        return self._row(row) if row is not None else None

    def fetchall(self):
        return [self._row(row) for row in self.raw.fetchall()]

    @staticmethod
    def _row(row):
        return Row({key: value.isoformat(sep=' ') if isinstance(value, datetime)
                    else value.isoformat() if isinstance(value, date) else value
                    for key, value in row.items()})

    @property
    def lastrowid(self):
        return self.raw.lastrowid


class Connection:
    def __init__(self):
        import pymysql
        self.raw = pymysql.connect(**options())

    def cursor(self):
        return Cursor(self)

    def execute(self, sql, args=None):
        if sql.strip().upper() == 'BEGIN IMMEDIATE':
            self.raw.begin()
            return self.cursor()
        return self.cursor().execute(sql, args)

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def close(self):
        self.raw.close()

    def __enter__(self):
        return self

    def __exit__(self, typ, value, traceback):
        self.rollback() if typ else self.commit()


def connect():
    return Connection()
