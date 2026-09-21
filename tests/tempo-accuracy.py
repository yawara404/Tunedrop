#!/usr/bin/env python3
"""テンポ (BPM) 推定のオクターブ判定を検証する。

ビートトラッカーは半速/倍速を間違えることがある (例: 実際 165.8 BPM の曲を
82.9 と返す)。vibe_analyzer.resolve_tempo() は実測値と AI 推定値から
半速/同速/倍速/4倍の候補を作り、次の証拠で採点して決める。

  1. 格子が捉えたオンセット量 (coverage) … 速すぎ/遅すぎの判定
  2. 格子の強さ (beat_strength)           … 疎疎な信号で強い拍を踏む格子を評価
  3. 120 BPM 付近を好む対数正規事前分布
  4. 参照BPM (AI推定) … オクターブが一致し、証拠が拮抗しているときだけ採用

ここでは既知の BPM で作った合成オンセット包絡 (クリック列) を与え、
librosa を使わずに判定だけを検証する。

実行: .venv/bin/python tests/tempo-accuracy.py
"""
import os
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vibe_analyzer as va

SR = 22050
HOP = 512
failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name} {detail}")


def click_env(bpm, seconds=30.0, subdivision=0.0, noise=0.0, seed=7):
    """BPM のクリック列をオンセット包絡 (強度の時系列) として作る。

    subdivision > 0 のときは 2倍テンポの位置にも弱いクリックを入れる
    (0.5 なら裏拍が表拍の半分の強さ)。noise は一様ノイズの混入率。
    """
    frames = int(seconds * SR / HOP) + 1
    env = np.zeros(frames, dtype="float64")
    period = 60.0 / float(bpm) * SR / HOP        # 1拍ぶんのフレーム数
    for position in np.arange(0.0, float(frames), period):
        index = int(round(position))
        if 0 <= index < frames:
            env[index] = 1.0
    if subdivision > 0:
        for position in np.arange(period / 2.0, float(frames), period):
            index = int(round(position))
            if 0 <= index < frames and env[index] < subdivision:
                env[index] = float(subdivision)
    if noise > 0:
        env = env + np.random.default_rng(seed).random(frames) * float(noise)
    return env


print("[1] テンポの事前分布 (120 BPM 付近を最も起こりやすいとする)")
check("120 BPM が最大", va.tempo_prior(120) > va.tempo_prior(85) > va.tempo_prior(60),
      (va.tempo_prior(120), va.tempo_prior(85), va.tempo_prior(60)))
check("遠いテンポほど小さい", va.tempo_prior(120) > va.tempo_prior(200) > 0)
check("0 以下は 0", va.tempo_prior(0) == 0 and va.tempo_prior(-10) == 0)

print("[2] 候補の生成 (半速/倍速/4倍 + 付点・3連 3:2 / 2:3)")
candidates = va.tempo_candidates(117.5)
check("55..210 BPM の範囲内のみ", all(55.0 <= c <= 210.0 for c in candidates), candidates)
check("重複しない", len(candidates) == len(set(round(c, 3) for c in candidates)),
      candidates)
check("実測そのもの (117.5) を含む", any(abs(c - 117.5) < 0.5 for c in candidates),
      candidates)
check("半速 (58.75) を含む", any(abs(c - 58.75) < 0.5 for c in candidates), candidates)
check("倍速 (235) は範囲外なので含まない", all(abs(c - 235.0) > 1.0 for c in candidates),
      candidates)
check("3:2 (176.25 = 117.5×1.5) を含む", any(abs(c - 176.25) < 0.5 for c in candidates),
      candidates)
check("2:3 (78.33 = 117.5×2/3) を含む", any(abs(c - 78.33) < 0.5 for c in candidates),
      candidates)

print("[3] 疎なクリック列 (82.9 BPM, 裏拍には何も無い)")
env = click_env(82.9)
bpm, info = va.resolve_tempo(env, SR, HOP, 82.9)
check("実測 82.9 を維持 (倍速にしない)", abs(bpm - 82.9) < 1.0, (bpm, info))
check("方法は beat_track", info["method"] == "beat_track", info["method"])

print("[4] 均等なクリック列 (165.8 BPM)")
env = click_env(165.8)
bpm, info = va.resolve_tempo(env, SR, HOP, 165.8)
check("実測 165.8 を維持 (半速にしない)", abs(bpm - 165.8) < 1.0, (bpm, info))

print("[5] 遅い候補が選ばれがちな信号 (全拍が同じ強さで 165.8)")
env = click_env(165.8, subdivision=0.9)
bpm, info = va.resolve_tempo(env, SR, HOP, 82.9)
check("半速ではなく 165.8 を選ぶ", abs(bpm - 165.8) < 1.0, (bpm, info))

print("[6] 証拠が十分に離れていれば、AI推定 (参照BPM) には譲らない")
env = click_env(210.0)   # 210 BPM 間隔。疎なおンセット信号で 105 と 210 のどちらとも取れる
bpm, info = va.resolve_tempo(env, SR, HOP, 210.0, reference_bpm=105.0)
check("実測 210 を維持", abs(bpm - 210.0) < 1.0, (bpm, info))
check("方法は beat_track", info["method"] == "beat_track", info["method"])
check("得点差 (margin) が基準以上", info["score_margin"] >= va.TEMPO_REF_MAX_MARGIN,
      info["score_margin"])

print("[6b] 参照BPM を採用するのは「ほぼ同点」のときだけ (採用ルールの単体検証)")


def _cand(bpm, score):
    """_adopt_reference に渡す (score, detail) を組み立てる。"""
    return (score, {"bpm": bpm, "coverage": 0.1, "beat_strength": 2.0,
                    "midpoint_ratio": 0.9, "beats": 100, "prior": 0.9, "score": score})


tied = [_cand(166.3, 0.200), _cand(110.9, 0.199)]      # ほぼ同点 + 別系列
bpm, info = va._adopt_reference(tied, tied[0], 120.0, "octave")
check("同点なら参照BPM側 (110.9) を採用", abs(bpm - 110.9) < 0.5, (bpm, info["method"]))
check("方法は reference", info["method"] == "reference", info["method"])

clear = [_cand(166.3, 0.200), _cand(110.9, 0.150)]     # 証拠が離れている
bpm, info = va._adopt_reference(clear, clear[0], 120.0, "octave")
check("離れていれば首位 (166.3) を維持", abs(bpm - 166.3) < 0.5, (bpm, info["method"]))
check("方法は octave のまま", info["method"] == "octave", info["method"])

same_branch = [_cand(143.6, 0.200), _cand(71.8, 0.150)]  # 首位と同じ系列の参照
bpm, info = va._adopt_reference(same_branch, same_branch[0], 140.0, "octave")
check("同じテンポ系列の参照には寄せない", abs(bpm - 143.6) < 0.5, (bpm, info["method"]))

print("[7] 証拠が拮抗していないときは参照BPMに譲らない")
env = click_env(100.0)      # 100 BPM 間隔 (間に拍が無い = 100 が確からしい)
bpm, info = va.resolve_tempo(env, SR, HOP, 100.0, reference_bpm=200.0)
check("実測 100 を維持", abs(bpm - 100.0) < 1.0, (bpm, info))
check("方法は beat_track", info["method"] == "beat_track", info["method"])

print("[8] 半速だと誤った実測を、証拠から正しく倍に補正する (KING のケース)")
env = click_env(165.8)
bpm, info = va.resolve_tempo(env, SR, HOP, 82.9, reference_bpm=165.8)
check("165.8 に補正", abs(bpm - 165.8) < 1.0, (bpm, info))
check("方法は octave か reference", info["method"] in ("octave", "reference"),
      info["method"])

print("[9] ノイズが混ざった信号でもオクターブを誤らない")
env = click_env(165.8, noise=0.25)
bpm, info = va.resolve_tempo(env, SR, HOP, 165.8)
check("165.8 を選ぶ", abs(bpm - 165.8) < 1.0, (bpm, info))

print("[10] align_tempo の安全弁 (証拠が無いときのフォールバック)")
check("KING のケース (82.9 + AI 165.8) は 165.8 に補正",
      abs(va.align_tempo(82.9, 165.8) - 165.8) < 0.5, va.align_tempo(82.9, 165.8))
check("付点 (3:2) の誤りも補正する",
      abs(va.align_tempo(117.5, 175.0) - 176.25) < 0.5, va.align_tempo(117.5, 175.0))
check("どの候補からも遠い参照には動かさない",
      abs(va.align_tempo(130.0, 170.0) - 130.0) < 0.5, va.align_tempo(130.0, 170.0))
check("参照が無効なら実測のまま", va.align_tempo(120.0, 0) == 120.0)
check("実測が無効なら 0", va.align_tempo(0, 120.0) == 0.0)

print("[11] 診断情報と確信度")
env = click_env(128.0)
bpm, info = va.resolve_tempo(env, SR, HOP, 128.0)
check("候補の内訳は最大3件", 0 < len(info["candidates"]) <= 3, info["candidates"])
check("内訳に coverage / prior / beats がある",
      all(key in info["candidates"][0] for key in ("coverage", "prior", "beats")),
      info["candidates"][0])
check("score_margin は 0..1", 0.0 <= info["score_margin"] <= 1.0, info["score_margin"])
check("確信度は 0..1", 0.0 <= va.tempo_confidence_from(info, 0.2) <= 1.0)
check("確信度はパルス明瞭度が高いほど高い",
      va.tempo_confidence_from(info, 0.3) >= va.tempo_confidence_from(info, 0.0))

print("[12] 証拠が無い入力でも壊れない")
bpm, info = va.resolve_tempo(np.zeros(0), SR, HOP, 0.0)
check("空の入力は 0 を返す", bpm == 0.0 and info["method"] == "none", (bpm, info))
bpm, info = va.resolve_tempo(np.zeros(4000), SR, HOP, 120.0, reference_bpm=120.0)
check("無音は参照BPMへ寄せるだけ", bpm == 120.0 and info["method"] == "reference", (bpm, info))


print("[13] CLAP のテンポ感を証拠として使う (英語プロンプト)")
check("slow は低 BPM を好む",
      va.clap_tempo_fit(70.0, {"slow": 1.0}) > va.clap_tempo_fit(190.0, {"slow": 1.0}))
check("fast は高 BPM を好む",
      va.clap_tempo_fit(190.0, {"fast": 1.0}) > va.clap_tempo_fit(70.0, {"fast": 1.0}))
check("判定なし (None) は影響しない", va.clap_tempo_fit(120.0, None) is None)
check("空の確率も影響しない", va.clap_tempo_fit(120.0, {}) is None)
check("未知のクラス名は無視される",
      va.clap_tempo_fit(120.0, {"unknown": 1.0}) is None)
env_clap = click_env(120.0)
# 同じ BPM でも、CLAP のテンポ感によって得点が変わることを確かめる
score_slow, _ = va.tempo_evidence(env_clap, SR, HOP, 90.0, {"slow": 1.0})
score_fast, detail = va.tempo_evidence(env_clap, SR, HOP, 90.0, {"fast": 1.0})
check("90 BPM は slow の印象の方が高得点", score_slow > score_fast,
      (score_slow, score_fast))
fast_slow, _ = va.tempo_evidence(env_clap, SR, HOP, 185.0, {"slow": 1.0})
fast_fast, _ = va.tempo_evidence(env_clap, SR, HOP, 185.0, {"fast": 1.0})
check("185 BPM は fast の印象の方が高得点", fast_fast > fast_slow,
      (fast_slow, fast_fast))
check("内訳に clap_tempo_fit を残す", "clap_tempo_fit" in detail, detail)
os.environ["TUNEDROP_CLAP_TEMPO_WEIGHT"] = "0"
check("重み 0 で無効化できる", va.clap_tempo_weight() == 0.0)
base_score, _ = va.tempo_evidence(env_clap, SR, HOP, 120.0, None)
off_score, _ = va.tempo_evidence(env_clap, SR, HOP, 120.0, {"slow": 1.0})
check("重み 0 ならテンポ感は効かない", abs(base_score - off_score) < 1e-9,
      (base_score, off_score))
os.environ.pop("TUNEDROP_CLAP_TEMPO_WEIGHT", None)

print("[14] 周期 (自己相関) の証拠")
acf_click = va.onset_periodicity(click_env(150.0), SR, HOP)
check("自己相関が得られる", len(acf_click) > 0, len(acf_click))
check("lag 0 は 1.0", abs(float(acf_click[0]) - 1.0) < 1e-6, acf_click[0])
check("クリック列の周期 (150 BPM) で高い",
      va.autocorr_evidence(acf_click, SR, HOP, 150.0) > 0.8,
      va.autocorr_evidence(acf_click, SR, HOP, 150.0))
check("周期から外れた値では低い",
      va.autocorr_evidence(acf_click, SR, HOP, 118.0)
      < va.autocorr_evidence(acf_click, SR, HOP, 150.0))
check("無音では None",
      va.autocorr_evidence(va.onset_periodicity(np.zeros(4000), SR, HOP), SR, HOP, 120.0)
      is None)

print("[15] BPM の微調整 (真のテンポは候補の近傍にある)")
refined, fit = va.refine_tempo(click_env(175.0), SR, HOP, 176.25)
check("近傍のうち格子が合う値へ寄る", abs(refined - 175.0) < 2.0,
      (refined, fit))

print("[16] 付点/3連 (3:2) の誤検出を補正する (ヨルニテのケース)")
env_dotted = click_env(175.0)
bpm, info = va.resolve_tempo(env_dotted, SR, HOP, 117.5)   # 実測が 2/3 に化けている
check("175 に補正", abs(bpm - 175.0) < 2.0, (bpm, info["method"]))
check("117.5 のままにならない", abs(bpm - 117.5) > 5.0, bpm)
print("-" * 60)
if failures:
    print(f"FAILED: {failures}")
    sys.exit(1)
print("PASS: テンポのオクターブ判定は証拠に基づき、参照BPMは拮抗時のみ採用される。")