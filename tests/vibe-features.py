#!/usr/bin/env python3
"""雰囲気特徴量のテンポ非依存性と境界値を検証する。"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vibe_analyzer as va


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


common = {
    "rms_db": -18.0,
    "onset_rate": 3.0,
    "pulse_clarity": 0.2,
    "regularity": 0.9,
    "centroid": 2100.0,
    "major_score": 0.7,
    "minor_score": 0.3,
    "harmonic_ratio": 0.6,
    "flatness": 0.04,
    "zcr": 0.08,
    "vocal_flux": 7.0,
    "band_ratio": 0.4,
    "hf_flatness": 0.05,
}

slow = va.vibe_features({**common, "tempo": 60.0})
fast = va.vibe_features({**common, "tempo": 180.0})
check("テンポだけで danceability が変わらない",
      slow["danceability"] == fast["danceability"],
      (slow["danceability"], fast["danceability"]))
check("テンポ特徴そのものは保持される",
      slow["tempo"] == 60.0 and fast["tempo"] == 180.0,
      (slow["tempo"], fast["tempo"]))

irregular = va.vibe_features({**common, "tempo": 120.0, "regularity": 0.1})
check("拍が不規則なら danceability が下がる",
      irregular["danceability"] < slow["danceability"],
      (irregular["danceability"], slow["danceability"]))

for result in (slow, fast, irregular):
    check("特徴量は有限な0..1値",
          all(0.0 <= result[key] <= 1.0 for key in (
              "energy", "danceability", "valence", "acousticness",
              "instrumentalness", "speechiness", "liveness")),
          result)

# energy は録音音量より音楽的な密度・駆動力を反映する (ゲイン非依存)。
busy_quiet = va.vibe_features({**common, "tempo": 120.0,
                               "rms_db": -32.0, "onset_rate": 5.0,
                               "pulse_clarity": 0.25})
loud_sparse = va.vibe_features({**common, "tempo": 120.0,
                                "rms_db": -6.0, "onset_rate": 0.5,
                                "pulse_clarity": 0.05})
check("静かでも密度が高い方が energy は高い",
      busy_quiet["energy"] > loud_sparse["energy"],
      (busy_quiet["energy"], loud_sparse["energy"]))

# 調性判定: フレーム単位で長調/短調を照合する。
import numpy as np

major_frames = np.asarray(va._MAJOR_PROFILE, dtype="float64").reshape(12, 1)
minor_frames = np.asarray(va._MINOR_PROFILE, dtype="float64").reshape(12, 1)
check("長調プロファイルは長調らしさが高い",
      va._mode_scores_frames(major_frames)[0] > va._mode_scores_frames(major_frames)[1])
check("短調プロファイルは短調らしさが高い",
      va._mode_scores_frames(minor_frames)[1] > va._mode_scores_frames(minor_frames)[0])
check("無音クロマは中立 (0.5, 0.5)",
      va._mode_scores_frames(np.zeros((12, 8))) == (0.5, 0.5))
check("空クロマは中立",
      va._mode_scores_frames(np.zeros((12, 0))) == (0.5, 0.5))

print("雰囲気特徴量の検証に成功しました。")
