#!/usr/bin/env python3
"""analysis_cache.protect_measured / write_merged のマージ保護を検証する。

音源解析済み (audio_engine あり) の行が Gemini 推定 pass (--no-audio 等) で
実測 BPM や CLAP mood を失わないこと、音源解析 pass は実測を更新できること、
audio_fields の feature_vector フォールバックを確認する。

実行: python3 tests/analysis-cache-protect.py
"""
import json
import os
import sys
import tempfile

ROOT = __import__("pathlib").Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import analysis_cache as ac

db = tempfile.mktemp(suffix=".sqlite")
failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name} {detail}")


print("[1] 音源解析結果を新規保存")
audio = {"tempo": 161.5, "tempo_source": "audio", "tempo_raw": 82.9,
         "mood": "happy", "vibe_tags": ["高速"], "measured": True,
         "feature_vector": [0.8, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
         "audio_engine": "librosa+clap"}
m = ac.write_merged(db, "aaaaaaaaaaa", audio)
check("tempo 保存", m["tempo"] == 161.5, m.get("tempo"))
check("measured 自動判定", m["measured"] is True, m.get("measured"))

print("[2] AI pass (gemini) が実測行を上書きしようとする → 保護される")
ai = {"tempo": 120.0, "tempo_source": "gemini", "mood": "dark", "vibe_tags": [],
      "engine": "gemini", "status": "ready",
      "feature_vector": [0.6, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]}
m = ac.write_merged(db, "aaaaaaaaaaa", ai)
check("実測 tempo 維持", m["tempo"] == 161.5, m.get("tempo"))
check("tempo_source 維持", m["tempo_source"] == "audio", m.get("tempo_source"))
check("実測 mood 維持", m["mood"] == "happy", m.get("mood"))
check("実測 vibe_tags 維持", m["vibe_tags"] == ["高速"], m.get("vibe_tags"))
check("実測 feature_vector 維持", m["feature_vector"][0] == 0.8, m.get("feature_vector"))
check("非実測キー (engine/status) は更新", m["engine"] == "gemini" and m["status"] == "ready",
      (m.get("engine"), m.get("status")))
check("measured 維持", m["measured"] is True, m.get("measured"))

print("[3] 旧エンジン (essentia) 由来の実測 pass も更新できる (互換値)")
audio2 = {"tempo": 165.0, "tempo_source": "essentia", "mood": "warm", "measured": True,
          "feature_vector": [0.82, 1, 1, 1, 1, 1, 1, 1], "audio_engine": "essentia"}
m = ac.write_merged(db, "aaaaaaaaaaa", audio2)
check("新実測 tempo で上書き", m["tempo"] == 165.0 and m["tempo_source"] == "essentia",
      (m.get("tempo"), m.get("tempo_source")))
check("新実測 mood で上書き", m["mood"] == "warm", m.get("mood"))

print("[4] AI pass (rules) が未実装音源行を更新する (audio_engine なし → 保護なし)")
fresh = {"tempo": 128.0, "tempo_source": "rules", "mood": "dreamy", "engine": "rules",
         "feature_vector": [0.64, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]}
m = ac.write_merged(db, "ccccccccccc", fresh)
check("AI tempo 書き込み", m["tempo"] == 128.0, m.get("tempo"))
check("measured=False", m["measured"] is False, m.get("measured"))

print("[5] その行が音源解析されると実測で上書きされる")
audio3 = {"tempo": 130.0, "tempo_source": "audio", "mood": "calm", "measured": True,
          "audio_engine": "librosa+clap",
          "feature_vector": [0.65, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]}
m = ac.write_merged(db, "ccccccccccc", audio3)
check("実測で上書き", m["tempo"] == 130.0 and m["tempo_source"] == "audio", m.get("tempo"))
check("measured=True", m["measured"] is True, m.get("measured"))

print("[6] 実測行に rules 由来 (engine のみ) の fields が来ても保護される")
legacy = {"engine": "rules", "status": "ready"}
m = ac.write_merged(db, "aaaaaaaaaaa", legacy)
check("tempo 変化なし", m["tempo"] == 165.0, m.get("tempo"))
check("mood 変化なし", m["mood"] == "warm", m.get("mood"))

print("[7] audio_fields は tempo>0 のとき tempo_source を付与する")
res7 = {"tempo": 98.6, "duration": 100, "engine": "librosa",
        "feature_vector": [9, 8, 7, 6, 5, 4, 3, 2],
        "beats": [1], "chorus": [], "chords": []}
out = ac.audio_fields({}, res7)
check("audio tempo_source", out.get("tempo_source") == "audio", out.get("tempo_source"))
check("AI vector が無い行は音源 vector を採用", out.get("feature_vector") == [9, 8, 7, 6, 5, 4, 3, 2],
      out.get("feature_vector"))
check("measured=True", out["measured"] is True, out.get("measured"))
out2 = ac.audio_fields({"feature_vector": [0.9, 0, 0, 0, 0, 0, 0, 0]}, res7)
check("既存 AI vector[0] を実測 tempo で差し替え", out2["feature_vector"][0] == 0.493,
      out2.get("feature_vector"))

os.remove(db)
print("-" * 60)
if failures:
    print(f"FAILED: {failures}")
    sys.exit(1)
print("ALL PROTECTION TESTS PASSED")