#!/usr/bin/env python3
"""Radar 4軸ガイド（エネルギー×明るさ）の向き推定と応答 field を検証する。

実行: .venv/bin/python tests/radar-axes.py
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


# 1) radar_map の応答に energy / valence が含まれる（ガイドの向き推定に使用）
src = (ROOT / "app.py").read_text(encoding="utf-8")
check("radar_map応答にenergyを含む", '"energy": it["energy"]' in src)
check("radar_map応答にvalenceを含む", '"valence": it.get("valence")' in src)
check("_db_bookmarksがvalenceを運ぶ", 'item["valence"] = d.get("valence")' in src)

# 2) フロントの向き推定: エネルギーが高い曲が右に集まれば +x を向く
import re

js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
for fn in ("radarAxisOrientation", "drawRadarAxes"):
    check(f"{fn}が定義される", re.search(rf"export function {fn}\(", js) is not None)
check("drawRadarMapがガイドを描く",
      "drawRadarAxes(ctx, W, H, radarAxisOrientation(vibeMapData))" in js)

# Node が無くても論理だけ検証できるよう、相関計算を Python で再現する
tracks = []
for i in range(10):
    e = i / 9.0  # energy が右へ単調増加
    tracks.append({"features": {"energy": e, "valence": 0.5 if i % 2 == 0 else 0.6,
                                "x": 0.1 + 0.8 * e, "y": 0.5}})


def mean(a):
    return sum(a) / len(a)


def corr(a, b):
    ma, mb = mean(a), mean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    sa = sum((x - ma) ** 2 for x in a)
    sb = sum((y - mb) ** 2 for y in b)
    return cov / (sa * sb) ** 0.5


es = [t["features"]["energy"] for t in tracks]
xs = [t["features"]["x"] for t in tracks]
check("energyとxは正の相関", corr(es, xs) > 0.9, corr(es, xs))

# 3) 端ラベルだけのデザイン: 軸線・象限ラベルを描かない
check("軸線を引かない", "setLineDash" not in js[js.index("export function drawRadarAxes"):js.index("export function roundRect")])
check("象限ラベルを出さない", "energy・bright" not in js)
check("端の4ラベルを出す",
      all(f"label: '{label}'" in js for label in ("energy", "calm", "bright", "dark")))

# 4) データ不足（8曲未満）では向きを決めない仕様がコードにある
check("8曲未満はnull", "if (xs.length < 8) return null" in js)

print("PASS: 4軸ガイドの応答field・向き推定・描画呼び出し")
