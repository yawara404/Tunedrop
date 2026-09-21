#!/usr/bin/env python3
"""既存ブックマークを Gemini(AI) + 音源解析(librosa/CLAP) で再解析するバッチ。

- Gemini: 曲名/アーティスト/カテゴリから特徴量と推定 BPM を取得
- 音源解析 (既定 librosa/CLAP): 音源を yt-dlp で取得し、実測 BPM と
  雰囲気 (energy / valence / mood など) を算出して実測値で上書き
  (オクターブ誤りは Gemini 推定値へ寄せて補正。失敗時は AI 推定値を維持)

使い方:
    python3 reanalyze_songs.py                    # 全ブックマークを再解析
    python3 reanalyze_songs.py --no-audio         # Gemini のみ (音源DLなし・高速)
    python3 reanalyze_songs.py --only GJI4Gv7NbmE # 1曲だけ
    python3 reanalyze_songs.py --limit 3          # 先頭3曲だけ
    python3 reanalyze_songs.py --db /path/to/database.sqlite

結果は database.sqlite の analysis_cache に保存され、Radar画面に反映される。
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "database.sqlite"


def fetch_bookmarks(db_path):
    """bookmarks を playlist の category と結合して取得 (重複IDは除去)。"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT b.youtube_id, b.title, b.channel, p.category
        FROM bookmarks b
        JOIN playlists p ON p.id = b.playlist_id
        ORDER BY b.added_at ASC, b.id ASC
    """).fetchall()
    conn.close()
    seen, out = set(), []
    for r in rows:
        vid = r["youtube_id"]
        if not vid or vid in seen:
            continue
        seen.add(vid)
        out.append({
            "youtube_id": vid,
            "title": r["title"] or "Unknown Title",
            "channel": r["channel"] or "Unknown Artist",
            "category": r["category"] or "Other",
        })
    return out


def main():
    ap = argparse.ArgumentParser(description="既存曲を Gemini + 音源解析で再解析")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="database.sqlite のパス")
    ap.add_argument("--no-audio", action="store_true",
                    help="音源解析をスキップして Gemini 推定のみ行う")
    ap.add_argument("--only", default="", help="この YouTube ID のみ再解析")
    ap.add_argument("--limit", type=int, default=0, help="先頭 N 曲だけ処理")
    ap.add_argument("--json", action="store_true", help="結果を JSON で出力")
    args = ap.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    if not db_path.is_file():
        print(f"database.sqlite が見つかりません: {db_path}", file=sys.stderr)
        return 1

    # app.py は import 時に TUNEDROP_DB を参照するため先に設定する
    os.environ["TUNEDROP_DB"] = str(db_path)
    sys.path.insert(0, str(ROOT))
    try:
        from app import reanalyze_bookmark
        from vibe_analyzer import engine_name
    except Exception as exc:
        print(f"app.py の読み込みに失敗しました: {exc}", file=sys.stderr)
        print("pip install flask flask-cors pyjwt waitress を実行してください。", file=sys.stderr)
        return 1

    targets = fetch_bookmarks(db_path)
    if args.only:
        targets = [b for b in targets if b["youtube_id"] == args.only]
    if args.limit > 0:
        targets = targets[:args.limit]
    if not targets:
        print("再解析対象のブックマークがありません。")
        return 0

    use_audio = not args.no_audio
    engine_label = engine_name() if use_audio else "-"
    print(f"対象 {len(targets)} 曲 / 音源解析: {'ON' if use_audio else 'OFF'} / エンジン: {engine_label}")
    print("-" * 78)

    summary = []
    for i, bm in enumerate(targets, 1):
        t0 = time.time()
        try:
            res = reanalyze_bookmark(bm["youtube_id"], bm["title"], bm["channel"],
                                     bm["category"], use_audio=use_audio)
            elapsed = time.time() - t0
            # 表示は analysis_cache のマージ結果を優先する。
            # (音源解析済みの曲は AI 再推定より既存の実測 BPM / mood が保持される)
            import analysis_cache as ac
            cached = ac.read(str(db_path), bm["youtube_id"]) or {}
            disp = dict(res)
            for key in ("tempo", "tempo_source", "tempo_raw", "tempo_confidence",
                        "mood", "vibe_tags", "measured", "audio_engine"):
                if cached.get(key) is not None:
                    disp[key] = cached[key]
            tempo = disp.get("tempo") or 0
            raw = disp.get("tempo_raw")
            src = disp.get("tempo_source") or "-"
            engine = disp.get("engine") or "-"
            audio_engine = disp.get("audio_engine") or ""
            measured = bool(disp.get("measured"))
            extra = ""
            if measured and raw and abs(float(raw) - float(tempo)) > 0.05:
                extra = f" (実測 {raw} をオクターブ補正)"
            if audio_engine:
                extra += f" audio={audio_engine}"
            err = res.get("audio_error")
            if err:
                extra = f" [音源解析失敗: {err[:60]}]"
            vibe = ",".join(disp.get("vibe_tags") or [])[:24]
            if vibe:
                extra += f" [{vibe}]"
            print(f"[{i}/{len(targets)}] {bm['title'][:34]:<34} "
                  f"{tempo:6.1f} BPM  {src:<8} engine={engine:<7} {elapsed:5.1f}s{extra}")
            summary.append({
                "youtube_id": bm["youtube_id"], "title": bm["title"],
                "tempo": tempo, "tempo_raw": raw, "tempo_source": src,
                "engine": engine, "measured": measured, "error": err,
                "mood": disp.get("mood"), "vibe_tags": disp.get("vibe_tags") or [],
                "seconds": round(elapsed, 1),
            })
        except Exception as exc:
            print(f"[{i}/{len(targets)}] {bm['title'][:34]:<34} 失敗: {str(exc)[:60]}")
            summary.append({"youtube_id": bm["youtube_id"], "title": bm["title"],
                            "error": str(exc)[:200]})

    measured_count = sum(1 for s in summary if s.get("measured"))
    print("-" * 78)
    print(f"完了: {len(summary)} 曲 / 実測BPM {measured_count} 曲 / "
          f"AI推定BPM {len(summary) - measured_count} 曲")

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
