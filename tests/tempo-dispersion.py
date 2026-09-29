#!/usr/bin/env python3
"""BPM推定の密集防止と分散性を検証するテスト。

従来のBPM推定では、未知曲が 140/143/145 や 160.0 に過剰に集中・密集する問題があった。
本テストでは以下の項目を検証する:
  1. 既知の代表曲に対して公式BPMが正確に返ること (Tell Your World=140, 千本桜=154, 夜に駆ける=130等)
  2. 未知曲に対して、同じ曲名・アーティストなら決定論的 (100% 再現可能) であること
  3. 未知曲のセットに対して、単一のBPM値に過剰に密集せず、自然な音楽的分布 (ベルカーブ) に分散すること
  4. LLM が失敗または 0 を返した際、分散したルールベースBPMへ確実にフォールバックすること
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ai_analyzer

failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS: {name}")
    else:
        failures.append(name)
        print(f"  FAIL: {name} - {detail}")


print("[1] 既知曲の正確な公式BPM判定 (ハルシネーション防止)")
check("Tell Your World は 140", ai_analyzer.lookup_known_tempo("livetune - Tell Your World", "初音ミク") == 140.0)
check("千本桜 は 154", ai_analyzer.lookup_known_tempo("千本桜", "WhiteFlame") == 154.0)
check("夜に駆ける は 130", ai_analyzer.lookup_known_tempo("夜に駆ける", "YOASOBI") == 130.0)
check("KING は 165.8", ai_analyzer.lookup_known_tempo("KING", "Kanaria") == 165.8)
check("Lemon は 87", ai_analyzer.lookup_known_tempo("Lemon", "米津玄師") == 87.0)
check("メルト は 170", ai_analyzer.lookup_known_tempo("メルト", "supercell") == 170.0)
check("未知曲は None", ai_analyzer.lookup_known_tempo("完全に未知のタイトル12345", "未知のアーティスト") is None)

print("[2] ルールベースBPMの決定論的再現性 (同じ曲には常に同じBPM)")
t1 = ai_analyzer.estimate_tempo_rule_based("ランダムな曲名A", "アーティストX", "Vocaloid")
t2 = ai_analyzer.estimate_tempo_rule_based("ランダムな曲名A", "アーティストX", "Vocaloid")
check("同一入力で同一BPM", t1 == t2, (t1, t2))

print("[3] 複数曲におけるBPM密集防止・自然な分散性")
sample_titles = [f"テスト楽曲_{i}_{hashlib.md5(str(i).encode()).hexdigest()[:6]}" for i in range(120)]
bpms = [ai_analyzer.estimate_tempo_rule_based(title, "Producer", "Vocaloid") for title in sample_titles]

from collections import Counter
counts = Counter(bpms)
most_common_bpm, max_count = counts.most_common(1)[0]
max_ratio = max_count / len(bpms)
print(f"  最大集中度: BPM {most_common_bpm} が {max_count}/{len(bpms)} 曲 ({max_ratio*100:.1f}%)")
print(f"  ユニークBPM種類数: {len(counts)} 種類 (最小: {min(bpms)}, 最大: {max(bpms)})")

check("最頻出BPMが全体の15%未満に分散されている (密集解消)", max_ratio < 0.15, f"{max_ratio*100:.1f}%")
check("30種類以上の多様なBPM値に分散している", len(counts) >= 30, len(counts))
check("すべてのBPMが健全な範囲 (40〜220) に収まっている", all(40.0 <= b <= 220.0 for b in bpms))

print("[4] キーワードによる音楽的テンポ補正")
slow_bpm = ai_analyzer.estimate_tempo_rule_based("静かな夜のピアノバラード", "アーティスト", "J-POP")
fast_bpm = ai_analyzer.estimate_tempo_rule_based("超高速疾走ロックチューン", "アーティスト", "J-POP")
check("バラード系はテンポが低め", slow_bpm <= 105.0, slow_bpm)
check("高速ロック系はテンポが高め", fast_bpm >= 140.0, fast_bpm)
check("高速系がバラード系より速い", fast_bpm > slow_bpm, (fast_bpm, slow_bpm))

print("[5] analyze() のフォールバック時の分散性 (140/160固定にならない)")
prev_engine = ai_analyzer.AI_ENGINE
original_ollama = ai_analyzer._call_ollama
original_bpm = ai_analyzer._call_llm_bpm
original_genre = ai_analyzer._call_llm_genre
try:
    ai_analyzer.AI_ENGINE = "ollama"
    ai_analyzer._call_ollama = lambda *_: {"energy": 0.8, "valence": 0.6}
    ai_analyzer._call_llm_bpm = lambda *_: {"tempo": 0}  # 不明(0)を返す
    ai_analyzer._call_llm_genre = lambda *_: {"genre": "Vocaloid", "vocal_type": "synthetic"}
    res1 = ai_analyzer.analyze("未知曲アルファ", "P", "Vocaloid")
    res2 = ai_analyzer.analyze("未知曲ベータ", "P", "Vocaloid")
    res3 = ai_analyzer.analyze("未知曲ガンマ", "P", "Vocaloid")
    check("フォールバック時 source は rules", res1["tempo_source"] == "rules")
    check("全曲 140 や 160 に固定化されていない", not (res1["tempo"] == res2["tempo"] == res3["tempo"] == 140.0))
    check("未知曲間でBPMが自然にばらついている", len({res1["tempo"], res2["tempo"], res3["tempo"]}) >= 2,
          (res1["tempo"], res2["tempo"], res3["tempo"]))
finally:
    ai_analyzer.AI_ENGINE = prev_engine
    ai_analyzer._call_ollama = original_ollama
    ai_analyzer._call_llm_bpm = original_bpm
    ai_analyzer._call_llm_genre = original_genre

# 単一値だけでなく狭い帯域への集中・キーワード補正後の端点集中を検出する。
from statistics import pstdev
large = [ai_analyzer.estimate_tempo_rule_based(f"未知_{i}", "Producer", "Vocaloid") for i in range(2000)]
check("標準偏差が18 BPM以上", pstdev(large) > 18, pstdev(large))
for keyword in ("ballad", "fast", "dance"):
    values = [ai_analyzer.estimate_tempo_rule_based(f"未知_{i} {keyword}", "Producer", "Lo-Fi") for i in range(2000)]
    check(f"{keyword} の端点集中を防ぐ", Counter(values).most_common(1)[0][1] / len(values) < 0.1)
from unittest.mock import patch
with patch.object(ai_analyzer, "AI_ENGINE", "ollama"), \
     patch.object(ai_analyzer, "_call_ollama", return_value={}), \
     patch.object(ai_analyzer, "_call_llm_genre", return_value={"genre": "Lo-Fi"}):
    with patch.object(ai_analyzer, "_call_llm_bpm", return_value={"tempo": 0}):
        result = ai_analyzer.analyze("未知曲", "Producer", "Vocaloid")
        expected = ai_analyzer.estimate_tempo_rule_based("未知曲", "Producer", "Lo-Fi")
        check("曲別ジャンルでBPMを推定", result["tempo"] == expected)
        check("マップ用BPMも同期", result["feature_vector"][0] == round(expected / 200, 4))
    with patch.object(ai_analyzer, "_call_llm_bpm", return_value={"tempo": 165.8}):
        check("LLMの小数BPMを保持", ai_analyzer.analyze("未知曲", "Producer", "Other")["tempo"] == 165.8)

print("-" * 60)
if failures:
    print(f"FAILED: {len(failures)} checks failed")
    sys.exit(1)
else:
    print("PASS: 推定BPMの分布・再現性・既知値の保持を検証しました。")
