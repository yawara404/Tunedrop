#!/usr/bin/env python3
"""analysis_cache 内の音源未実測かつ密集している BPM 推定値を、
改善された分散型 BPM 推定 (既知曲公式辞書 + 音楽的ベルカーブ分散) で再計算・更新するスクリプト。

- measured=True (音源実測済み) の曲は 100% 保護 (変更しません)
- manual_bpm=True (管理画面での手動入力) の曲も 100% 保護 (変更しません)
- 音源未実測の曲のみ、既知曲公式BPMまたは自然に分散した整数BPMへ更新
"""
import json
import os
import shutil
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "database.sqlite"
BACKUP_DIR = ROOT / "backups"

sys.path.insert(0, str(ROOT))
import ai_analyzer


def main():
    if not DB_PATH.is_file():
        print(f"Database not found: {DB_PATH}", file=sys.stderr)
        return 1

    # 1. バックアップの作成
    BACKUP_DIR.mkdir(exist_ok=True)
    backup_file = BACKUP_DIR / f"database.sqlite.before_tempo_fix_{int(time.time())}"
    shutil.copy2(DB_PATH, backup_file)
    print(f"Backup created at: {backup_file}")

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout = 10000;")
    conn.row_factory = sqlite3.Row

    # 曲のタイトル、アーティスト、カテゴリのマッピングを作成
    bm_rows = conn.execute("""
        SELECT b.youtube_id, b.title, b.channel, p.category
        FROM bookmarks b
        JOIN playlists p ON p.id = b.playlist_id
    """).fetchall()

    song_info = {}
    for r in bm_rows:
        vid = r["youtube_id"]
        if vid and vid not in song_info:
            song_info[vid] = {
                "title": r["title"] or "",
                "channel": r["channel"] or "",
                "category": r["category"] or "Other",
            }

    # analysis_cache を取得
    cache_rows = conn.execute("SELECT youtube_id, data FROM analysis_cache").fetchall()
    print(f"Total analysis_cache entries: {len(cache_rows)}")

    before_tempos = []
    after_tempos = []
    updated_count = 0
    skipped_measured = 0
    skipped_manual = 0

    to_update = []

    for r in cache_rows:
        vid = r["youtube_id"]
        try:
            d = json.loads(r["data"])
        except Exception:
            continue

        orig_tempo = d.get("tempo")
        if orig_tempo is not None:
            before_tempos.append(round(float(orig_tempo), 1))

        # 実測済みの曲は保護
        if d.get("measured") or d.get("tempo_source") in ("audio", "librosa", "clap", "essentia"):
            skipped_measured += 1
            if orig_tempo is not None:
                after_tempos.append(round(float(orig_tempo), 1))
            continue

        # 手動設定済みの曲は保護
        if d.get("manual_bpm") or d.get("tempo_source") == "manual":
            skipped_manual += 1
            if orig_tempo is not None:
                after_tempos.append(round(float(orig_tempo), 1))
            continue

        # 未実測曲の情報を取得
        info = song_info.get(vid, {})
        title = info.get("title") or d.get("title") or ""
        channel = info.get("channel") or d.get("channel") or ""
        category = info.get("category") or d.get("category") or "Other"

        # 新しい推定ロジックでBPMを算出
        known = ai_analyzer.lookup_known_tempo(title, channel)
        if known is not None:
            new_tempo = float(known)
            new_source = "known"
        else:
            new_tempo = ai_analyzer.estimate_tempo_rule_based(title, channel, category)
            new_source = "rules"

        # データを更新
        d["tempo"] = new_tempo
        d["tempo_source"] = new_source
        if "feature_vector" in d and isinstance(d["feature_vector"], list) and len(d["feature_vector"]) >= 1:
            d["feature_vector"][0] = round(max(0.0, min(1.0, new_tempo / 200.0)), 4)

        after_tempos.append(round(new_tempo, 1))
        to_update.append((json.dumps(d, ensure_ascii=False), vid))
        updated_count += 1

    # DBへ一括書き込み
    conn.executemany("UPDATE analysis_cache SET data = ? WHERE youtube_id = ?", to_update)
    conn.commit()
    conn.close()

    print(f"\nMigration completed successfully!")
    print(f"  Updated unmeasured songs: {updated_count}")
    print(f"  Skipped measured songs:   {skipped_measured} (kept exact measured values)")
    print(f"  Skipped manual songs:     {skipped_manual} (kept manual BPMs)")

    print("\n--- BPM Distribution BEFORE Migration (Top 10) ---")
    for bpm, count in Counter(before_tempos).most_common(10):
        print(f"  BPM {bpm:5.1f}: {count:3d} songs ({count/len(before_tempos)*100:.1f}%)")

    print("\n--- BPM Distribution AFTER Migration (Top 10) ---")
    for bpm, count in Counter(after_tempos).most_common(10):
        print(f"  BPM {bpm:5.1f}: {count:3d} songs ({count/len(after_tempos)*100:.1f}%)")

    max_after_count = Counter(after_tempos).most_common(1)[0][1]
    print(f"\nResult: Highest peak reduced from {Counter(before_tempos).most_common(1)[0][1]} songs ({Counter(before_tempos).most_common(1)[0][1]/len(before_tempos)*100:.1f}%) to {max_after_count} songs ({max_after_count/len(after_tempos)*100:.1f}%)!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
