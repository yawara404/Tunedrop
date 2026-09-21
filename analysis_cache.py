#!/usr/bin/env python3
"""analysis_cache (SQLite) の読み書き共有ヘルパー。

AI 推定特徴量 (Gemini) と音源解析の実測値 (librosa / CLAP) を
同じ行に共存させるためのマージ処理を一元化する。
"""
import json
import math
import sqlite3
import time
from contextlib import closing

CACHE_TTL = 86400 * 7
# PHP (MAMP/api.php) と同時に書き込むため、ロック待ちは短くしておく。
# 長く待つと FastCGI の idle timeout (30秒) を超えてリクエストが切れる。
BUSY_TIMEOUT_MS = 5000
# 「実測 BPM」とみなす tempo_source の値
# ("essentia" は旧エンジンで測った既存行のための互換値)
MEASURED_SOURCES = ("audio", "librosa", "clap", "essentia")
# 実測 BPM を算出したアルゴリズムの版 (vibe_analyzer.TEMPO_ALGO_VERSION と同値)。
# 版が上がったら既存の実測 BPM も測り直す (app.py の再解析バッチが判定に使う)。
# v2: 打楽器成分のオンセット + オクターブ候補の証拠採点
# v3: 付点/3連候補 (3:2 / 2:3) ・周期 (自己相関) の証拠 ・BPM の微調整 ・CLAP のテンポ感
TEMPO_ALGO_VERSION = 3
# AI 推定由来の tempo_source / engine の値
AI_TEMPO_SOURCES = ("gemini", "rules")
# 音源解析済み (audio_engine あり) の行で AI 上書きから守る実測フィールド
MEASURED_KEYS = (
    "tempo", "tempo_source", "tempo_raw", "tempo_confidence",
    "tempo_method", "tempo_candidates", "tempo_algo",
    "energy", "danceability", "valence", "acousticness",
    "instrumentalness", "speechiness", "liveness",
    "mood", "vibe_tags", "vibe_scores", "vibe_clap", "feature_vector",
)


def connect(db_path, timeout_seconds=5):
    """ロック待ち時間を明示した SQLite 接続を返す。"""
    db = sqlite3.connect(db_path, timeout=timeout_seconds)
    db.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};")
    return db


def num(v, default=0.0):
    """安全に float へ変換する (None/NaN/Inf/不正値は default)。"""
    try:
        f = float(v)
    except Exception:
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


def ensure_table(db):
    db.execute("CREATE TABLE IF NOT EXISTS analysis_cache ("
               "youtube_id TEXT PRIMARY KEY, data TEXT NOT NULL, "
               "updated_at INTEGER NOT NULL)")


def read(db_path, video_id, ttl=None):
    """キャッシュを dict で返す。ttl 指定時は古いエントリを無視する。"""
    try:
        with closing(connect(db_path, timeout_seconds=10)) as db:
            row = db.execute(
                "SELECT data, updated_at FROM analysis_cache WHERE youtube_id=?",
                (video_id,)).fetchone()
        if not row:
            return None
        if ttl is not None and int(row[1]) <= time.time() - ttl:
            return None
        data = json.loads(row[0])
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def protect_measured(existing, fields):
    """音源解析済みの行を AI 推定フィールドが上書きしないようにする。

    既存行が audio_engine を持つ (= 過去に音源解析の実測値を得た) 場合、
    AI 推定 (gemini / rules) 由来の fields が実測 BPM や CLAP のムード等を
    壊さないよう、該当キー (MEASURED_KEYS) を取り除いて返す。

    音源解析済みの行は音源解析 pass (tempo_source が実測値) でのみ更新し、
    Gemini のみの再解析 (--no-audio 等) では実測値を保持する。
    音源解析が未実施の行や音源由来の fields はそのまま返す。
    """
    if not isinstance(fields, dict):
        return fields
    if not isinstance(existing, dict) or not existing.get("audio_engine"):
        return fields
    src = fields.get("tempo_source") or fields.get("engine")
    if src not in AI_TEMPO_SOURCES:
        return fields
    return {k: v for k, v in fields.items() if k not in MEASURED_KEYS}


def write_merged(db_path, video_id, fields):
    """既存エントリに fields をマージして保存し、マージ結果を返す。

    merge 前に protect_measured() を通すため、音源解析済みの行は
    AI 推定 pass (Gemini のみ再解析など) で実測値を失わない。
    measured は tempo_source から自動判定する。
    """
    try:
        with closing(connect(db_path, timeout_seconds=15)) as db:
            ensure_table(db)
            row = db.execute("SELECT data FROM analysis_cache WHERE youtube_id=?",
                             (video_id,)).fetchone()
            merged = {}
            if row:
                try:
                    decoded = json.loads(row[0])
                    if isinstance(decoded, dict):
                        merged = decoded
                except Exception:
                    merged = {}
            merged.update(protect_measured(merged, fields or {}))
            merged["measured"] = merged.get("tempo_source") in MEASURED_SOURCES
            db.execute("INSERT INTO analysis_cache VALUES (?, ?, ?) "
                       "ON CONFLICT(youtube_id) DO UPDATE SET "
                       "data=excluded.data, updated_at=excluded.updated_at",
                       (video_id, json.dumps(merged, ensure_ascii=False),
                        int(time.time())))
            # closing() は接続を閉じるだけでコミットしないため明示的にコミットする
            db.commit()
        return merged
    except Exception:
        return None


def audio_fields(existing, result, tempo_source="audio"):
    """音源解析結果 (librosa / CLAP) からキャッシュ反映フィールドを作る。

    - tempo があれば実測値として上書き (tempo_source を付与)
    - AI 側の 8次元 feature_vector は次元数を変えず、tempo 要素のみ更新
    - 音響特徴ベクトルは audio_feature_vector として保持
    """
    out = {
        "duration": round(num(result.get("duration")), 2),
        "chorus": result.get("chorus", []),
        "beats": result.get("beats", []),
        "chords": result.get("chords", []),
        "audio_feature_vector": result.get("feature_vector", []),
        "audio_engine": result.get("engine"),
        "measured": True,
    }
    for key in ("vibe_scores", "vibe_tags", "tempo_confidence", "tempo_raw",
                "tempo_method", "tempo_candidates", "vibe_clap"):
        if result.get(key) is not None:
            out[key] = result[key]
    tempo = num(result.get("tempo"))
    if tempo > 0:
        out["tempo"] = round(tempo, 1)
        out["tempo_source"] = tempo_source
        # どの版のアルゴリズムで測ったかを記録する (版が古い行は再測定の対象になる)
        out["tempo_algo"] = int(num(result.get("tempo_algo"), TEMPO_ALGO_VERSION)
                                or TEMPO_ALGO_VERSION)
        fv = existing.get("feature_vector")
        if isinstance(fv, list) and fv:
            # feature_vector[0] は tempo 正規化値 (分母 200, 0..1 clamp)
            vec = list(fv)
            vec[0] = round(max(0.0, min(1.0, tempo / 200.0)), 4)
            out["feature_vector"] = vec
        elif isinstance(result.get("feature_vector"), list) and result["feature_vector"]:
            # AI 推定 feature_vector が無い行 (音源のみ解析) は音源由来ベクトルを使う
            out["feature_vector"] = list(result["feature_vector"])
    if result.get("warn"):
        out["warn"] = result["warn"]
    return out
