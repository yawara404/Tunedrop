#!/usr/bin/env python3
"""librosa (+ CLAP) による「雰囲気」音源解析。

既定の音源解析エンジン。音源から直接
  - 実測 BPM / ビート位置
  - 雰囲気特徴 (energy / danceability / valence / acousticness /
    instrumentalness / speechiness / liveness)
  - mood ラベル (CLAP があれば音声×テキスト類似度、無ければ特徴量から推定)
  - UMAP 用の 8次元 feature_vector
を計算し、analysis_cache にマージ保存する。

依存: librosa (必須) / laion-clap (任意・あると mood 精度が上がる)

環境変数:
  TUNEDROP_VIBE_ENGINE=auto|librosa|clap   (既定 auto = clapがあれば使う)
  TUNEDROP_CLAP_CKPT=<path>                (CLAP 重みのローカルパス)
"""
import math
import os
import shutil
import tempfile
import time

import analysis_cache
import audio_download

SR = 22050
MOODS = ["happy", "sad", "calm", "energetic", "dark", "dreamy", "aggressive", "warm"]

# ==========================================================
# テンポ (BPM) 推定の設定
# ==========================================================
TEMPO_MIN = 55.0             # 楽曲テンポとして扱う下限 (BPM)
TEMPO_MAX = 210.0            # 同 上限
TEMPO_PRIOR_BPM = 120.0      # 対数正規事前分布の中心 (最も起こりやすいテンポ)
TEMPO_PRIOR_OCTAVES = 0.85   # 同 標準偏差 (オクターブ)。TAN 事前分布に近い設定
# 候補として検討する倍率。
# 半速/倍速 (オクターブ) に加えて、付点・3連系の 3:2 (1.5倍) と 2:3 (0.667倍) も含める。
# 例: 実際は 175 BPM の曲を 117.5 (=175×2/3) と誤検出するケースを救う。
TEMPO_CANDIDATE_FACTORS = (0.5, 2.0 / 3.0, 1.0, 1.5, 2.0, 4.0)
# 格子の強さ (ビート位置のオンセット強度平均 / 全体平均) の正規化上限。
# これ以上は「十分強い拍を踏んでいる」とみなして満点にする。
TEMPO_STRENGTH_FULL = 32.0
# オンセット包絡の自己相関 (周期の証拠) の満点値。この値以上で満点にする。
TEMPO_ACF_FULL = 0.75
# 周期の証拠を採点へ効かせる下限 (証拠が 0 でもこの割合は残す)。
TEMPO_ACF_MIN_TERM = 0.35
# 事前分布を掛ける強さ (0 = 使わない / 1 = そのまま掛ける)。
# 事前分布は「ありがちなテンポ」を好むだけで、実際に速い曲 (例: 175 BPM) を
# 不当に下げないよう、効きを弱める。
TEMPO_PRIOR_WEIGHT = 0.5
# 候補BPMの近傍を細かく走査して、格子が最も合う値へ寄せる (真のテンポは候補の近くにある)
TEMPO_REFINE_SPAN = 0.05       # ±5%
TEMPO_REFINE_STEPS = 21
# 参照BPM (AI推定) を採用する条件:
#   1) 候補が参照BPMとこの割合以内で一致していること (整合の確認)
TEMPO_REF_TOLERANCE = 0.12
#   2) その候補のスコアが首位のこの割合以上であること (証拠が拮抗しているときだける)
TEMPO_REF_MIN_SCORE_RATIO = 0.9
#   3) 首位と2位の得点差 (margin) がこれ未満であること。
#      証拠が十分に離れているときは AI 推定へ譲らない (実測の方が信頼できるため)。
TEMPO_REF_MAX_MARGIN = 0.05
#   3) 参照候補が首位とこの倍率以内 (log2) なら「同じオクターブ」とみなして譲らない。
#      同じオクターブ内の数値差は実測の精度の問題で、AI推定に寄せる必要がない。
TEMPO_REF_SAME_OCTAVE = 0.3
# 打楽器成分がこの割合未満の曲 (アカペラ/環境音など) は全帯域のオンセットで解析する
PERCUSSIVE_MIN_RATIO = 0.02

# CLAP で使うムード判定プロンプト (音声とテキストの類似度で選ぶ)。
# プロンプトは音楽の「曲」を指すよう song/track/singing を明記する。
CLAP_PROMPTS = {
    "happy": "a happy, joyful and upbeat pop song",
    "sad": "a sad, melancholic and emotional ballad",
    "calm": "a calm, quiet and relaxing song",
    "energetic": "an energetic, driving and exciting rock track",
    "dark": "a dark, eerie and mysterious track",
    "dreamy": "a dreamy, floating and ethereal song",
    "aggressive": "an aggressive, intense and heavy metal track",
    "warm": "a warm, cozy and gentle acoustic song",
}
# インストゥルメンタル判定用プロンプト (librosa だけでは精度が出にくいため)
CLAP_INSTRUMENTAL_PROMPTS = {
    "instrumental": "an instrumental track with no singing voice",
    "vocal": "a song with a clear lead vocal",
}
# MusicLayer 対応モデル (fusion 版) でのみ有効なボーカル範囲プロンプト。
# unfused 版では使えないため sl 結果の参考表示に留める。
CLAP_VOCAL_PROMPTS = {
    "vocal_low": "very low pitched male vocals singing in a song",
    "vocal_mid": "mid-range vocals singing in a song",
    "vocal_high": "high-pitched vocals singing in a song",
    "no_vocal": "a song with no vocals at all",
}


def _clamp01(v):
    try:
        f = float(v)
    except Exception:
        return 0.0
    if f != f:
        return 0.0
    return max(0.0, min(1.0, f))


def _num(v, default=0.0):
    return analysis_cache.num(v, default)


def tempo_in_range(bpm):
    """楽曲テンポとして扱える範囲 (TEMPO_MIN..TEMPO_MAX) かどうか。"""
    b = _num(bpm)
    return TEMPO_MIN <= b <= TEMPO_MAX


def tempo_prior(bpm):
    """テンポの対数正規事前分布 (0..1)。120 BPM 付近を最も起こりやすく見積もる。

    人間が「テンポ」として認識しやすい領域は 120 BPM 付近に集中するため、
    オクターブ (半速/倍速) の候補が拮抗したときの重みとして使う。
    (madmom / Essentia の TAN 事前分布と同じ考え方)
    """
    b = _num(bpm)
    if b <= 0:
        return 0.0
    z = math.log2(b / TEMPO_PRIOR_BPM) / TEMPO_PRIOR_OCTAVES
    return math.exp(-0.5 * z * z)


def tempo_candidates(*bases):
    """テンポ候補 (半速/同速/倍速/4倍) を範囲内だけ集めて重複を除いて返す。

    bases には実測テンポと (あれば) AI 推定テンポを渡す。AI 推定値も候補として
    残すことで、AI 側の方が正しいオクターブだった場合に選べるようにする。
    """
    out = []
    for base in bases:
        b = _num(base)
        if b <= 0:
            continue
        for factor in TEMPO_CANDIDATE_FACTORS:
            cand = b * factor
            if not tempo_in_range(cand):
                continue
            if not any(abs(cand - existing) < 0.5 for existing in out):
                out.append(cand)
    return out


def _grid_index(start, frames, lag):
    """start から lag 間隔のビート格子位置 (整数フレーム) を返す。

    四捨五入で求めるため、拍間隔が非整数でもフレーム境界のずれが蓄積しない。
    (切り捨てでは曲の後半で拍がオンセットから外れて取りこぼす)
    """
    import numpy as np

    if lag <= 0 or frames <= 0:
        return np.zeros(0, dtype=int)
    idx = np.round(np.arange(float(start), float(frames), float(lag))).astype(int)
    return idx[(idx >= 0) & (idx < frames)]


def _peak_values(env, idx, window=1):
    """格子位置のオンセット強度。±window フレームの最大値を取る。

    オンセット検出の1フレーム程度のずれや、演奏の僅かな揺れを吸収するため。
    """
    import numpy as np

    if idx.size == 0:
        return np.zeros(0, dtype="float64")
    n = int(env.size)
    values = env[idx]
    for shift in range(1, max(1, int(window)) + 1):
        values = np.maximum(values, env[np.clip(idx - shift, 0, n - 1)])
        values = np.maximum(values, env[np.clip(idx + shift, 0, n - 1)])
    return values


def grid_evidence(onset_env, sr, hop_length, bpm, phases=12):
    """BPM のビート格子がオンセット (音の立ち上がり) をどれだけ捉えるかを調べる。

    librosa に依存しない純粋な計算なので、単体テスト (tests/tempo-accuracy.py) で
    合成オンセット列を与えて検証できる。

    返り値: (coverage, beat_strength, midpoint_ratio, beats)
      coverage       … 格子位置が捉えたオンセット強度の割合 (0..1)
                       格子が粗すぎる (候補が遅すぎる) と捉え損ねて下がり、
                       格子が細かすぎる (候補が速すぎる) と空振りの拍が増えて下がる
      beat_strength  … 格子位置のオンセット強度平均 / 全体平均。
                       粒の揃った疎な信号 (クリック列) で「より強い拍だけを踏む」格子を評価する
      midpoint_ratio … 格子の中間 (裏拍) の強度 / 格子位置の強度 (診断用)。
                       1.0 に近い = 裏拍も同じ強さ = 本来は倍のテンポ
      beats          … 生成できたビート数 (少なすぎる格子は証拠として使わない)
    """
    import numpy as np

    env = np.asarray(onset_env, dtype="float64").reshape(-1)
    n = int(env.size)
    b = _num(bpm)
    if n < 8 or b <= 0:
        return 0.0, 0.0, 1.0, 0
    lag = (60.0 / b) * float(sr) / float(max(1, hop_length))
    if lag < 2.0:            # 2フレーム未満は解像度不足で判定できない
        return 0.0, 0.0, 1.0, 0
    total = float(env.sum())
    mean_env = total / float(n)
    if mean_env <= 1e-9:
        return 0.0, 0.0, 1.0, 0

    best = None
    for k in range(max(1, int(phases))):
        phase = lag * k / max(1, int(phases))   # 位相をずらして最も強い格子を探す
        idx = _grid_index(phase, n, lag)
        if idx.size < 4:
            continue
        beat_values = _peak_values(env, idx)
        beat = float(beat_values.mean())
        mid = _grid_index(phase + lag / 2.0, n, lag)
        mid_mean = float(_peak_values(env, mid).mean()) if mid.size else 0.0
        if best is None or beat > best[0]:
            best = (beat, mid_mean, idx, beat_values, int(idx.size))
    if best is None:
        return 0.0, 0.0, 1.0, 0

    beat, mid_mean, idx, beat_values, beats = best
    coverage = min(1.0, max(0.0, float(beat_values.sum()) / total))
    mid_ratio = (mid_mean / beat) if beat > 1e-9 else 1.0
    return (coverage, float(beat / mean_env),
            float(max(0.0, min(1.0, mid_ratio))), beats)


def clap_tempo_weight():
    """CLAP のテンポ感を採点に効かせる重み (TUNEDROP_CLAP_TEMPO_WEIGHT)。

    0 で無効、1 でビート証拠と同じ重み。未設定は CLAP_TEMPO_WEIGHT (0.35)。
    """
    raw = os.environ.get("TUNEDROP_CLAP_TEMPO_WEIGHT", "").strip()
    if not raw:
        return CLAP_TEMPO_WEIGHT
    return _clamp01(_num(raw, CLAP_TEMPO_WEIGHT))


def clap_tempo_fit(bpm, tempo_probs):
    """CLAP のテンポ感 (slow/mid/upbeat/fast の確率) から、その BPM らしさを 0..1 で返す。

    各クラスの代表 BPM を中心に、対数スケール (オクターブ単位) のガウスで評価し、
    クラス確率で重み付け平均する。確率が無い (CLAP 未導入など) 場合は None を返し、
    採点には一切影響しない。
    """
    if not isinstance(tempo_probs, dict) or not tempo_probs:
        return None
    total, weight = 0.0, 0.0
    for name, prob in tempo_probs.items():
        center = CLAP_TEMPO_CENTERS.get(name)
        p = _clamp01(prob)
        if center is None or p <= 0.0:
            continue
        z = math.log2(max(1e-9, _num(bpm)) / center) / CLAP_TEMPO_SIGMA_OCTAVES
        total += p * math.exp(-0.5 * z * z)
        weight += p
    if weight <= 0.0:
        return None
    return _clamp01(total / weight)


def onset_periodicity(onset_env, sr, hop_length):
    """オンセット包絡の正規化自己相関 (lag 0 が 1.0) を返す。

    「音の立ち上がりが一定間隔で繰り返しているか」を測る、テンポ推定の古典的な証拠。
    ビート格子の当てはめ (grid_evidence) が弱い曲 (ドラムが薄い、打ち込みが細かい等)
    でも、周期性そのものは残るため、候補の選択に効く。
    """
    import librosa
    import numpy as np

    env = np.asarray(onset_env, dtype="float64").reshape(-1)
    if env.size < 8:
        return np.zeros(0)
    # 最も遅いテンポ (TEMPO_MIN) の 4倍音まで見れば足りる
    max_lag = int(round((60.0 / TEMPO_MIN) * float(sr) / float(max(1, hop_length)) * 4))
    acf = np.asarray(librosa.autocorrelate(env, max_size=max(1, max_lag)),
                     dtype="float64")
    if acf.size == 0 or abs(float(acf[0])) <= 1e-9:
        return np.zeros(0)
    return acf / float(acf[0])


def autocorr_evidence(acf, sr, hop_length, bpm):
    """周期性スコア (0..1)。ビート間隔 lag における自己相関を正規化して返す。

    「そのテンポで音の立ち上がりが繰り返しているか」を直接測る。ビート格子の
    当てはめ (coverage) が弱い曲でも周期そのものは残るため、候補選択に効く。
    acf が無い (無音など) 場合は None を返し、採点には影響しない。
    """
    if acf is None or len(acf) == 0:
        return None
    lag = (60.0 / max(1e-9, _num(bpm))) * float(sr) / float(max(1, hop_length))
    index = int(round(lag))
    if index <= 0 or index >= len(acf):
        return None
    return _clamp01(float(acf[index]) / TEMPO_ACF_FULL)


def refine_tempo(onset_env, sr, hop_length, bpm):
    """候補BPMの近傍 (±TEMPO_REFINE_SPAN) を走査し、格子が最も合う値に寄せる。

    ビートトラッカーの出力 (または倍率を掛けた候補) は真のテンポから数%ずれる。
    ずれたままだと coverage (捉えたオンセット量) が落ちて、正しい候補が
    選ばれにくくなるため、近傍を細かく探して最良の値に合わせる。
    """
    import numpy as np

    base = _num(bpm)
    if base <= 0:
        return base, None
    best_bpm, best_score = base, None
    for factor in np.linspace(1.0 - TEMPO_REFINE_SPAN, 1.0 + TEMPO_REFINE_SPAN,
                              max(3, int(TEMPO_REFINE_STEPS))):
        cand = base * float(factor)
        if not tempo_in_range(cand):
            continue
        coverage, strength, _mid, beats = grid_evidence(onset_env, sr, hop_length, cand)
        if beats < 4 or strength <= 0.0:
            continue
        score = coverage * strength      # 局所探索なので bpm に依存しない項は除く
        if best_score is None or score > best_score:
            best_bpm, best_score = cand, score
    return best_bpm, best_score


def tempo_evidence(onset_env, sr, hop_length, bpm, tempo_probs=None, acf=None):
    """候補BPMの採点。次の証拠を掛け合わせる。

      - 捉えたオンセット量 (coverage) … 速すぎ/遅すぎの判定
        (遅すぎ → 拍間のオンセットを捉え損ねる / 速すぎ → 空振りの拍が増える)
      - 格子の強さ (beat_strength) … 疎な信号で「より強い拍を踏む」格子を選ぶ
      - 事前分布 (prior) … 120 BPM 付近をはじめに優先する (効きは弱め)
      - 周期 (acf) … オンセット包絡の自己相関。周期がはっきりしている候補を高評価
      - CLAP のテンポ感 (tempo_probs) … 英語プロンプトによる「速い/遅い」の印象 (任意)

    返り値: (score, detail)。detail は解析結果に残す内訳 (UI/デバッグ用)。
    """
    coverage, strength, mid_ratio, beats = grid_evidence(onset_env, sr, hop_length, bpm)
    detail = {
        "bpm": round(_num(bpm), 1),
        "coverage": round(coverage, 3),
        "beat_strength": round(strength, 3),
        "midpoint_ratio": round(mid_ratio, 3),
        "beats": beats,
        "prior": round(tempo_prior(bpm), 3),
        "score": 0.0,
    }
    if strength <= 0.0 or beats < 4:
        return 0.0, detail
    coverage_term = 0.35 + 0.65 * _clamp01(coverage)
    # 強度は上限つき (log) で正規化し、疎な格子だけが有利になりすぎないようにする
    strength_term = 0.25 + 0.75 * _clamp01(
        math.log2(1.0 + strength) / math.log2(1.0 + TEMPO_STRENGTH_FULL))
    prior_term = (1.0 - TEMPO_PRIOR_WEIGHT) + TEMPO_PRIOR_WEIGHT * tempo_prior(bpm)
    score = coverage_term * strength_term * prior_term
    periodicity = autocorr_evidence(acf, sr, hop_length, bpm)
    if periodicity is not None:
        acf_term = TEMPO_ACF_MIN_TERM + (1.0 - TEMPO_ACF_MIN_TERM) * periodicity
        score *= acf_term
        detail["periodicity"] = round(periodicity, 3)
    hint = clap_tempo_fit(bpm, tempo_probs)
    if hint is not None:
        weight = clap_tempo_weight()
        score *= (1.0 - weight) + weight * hint
        detail["clap_tempo_fit"] = round(hint, 3)
    detail["score"] = round(score, 4)
    return float(score), detail


def resolve_tempo(onset_env, sr, hop_length, raw_bpm, reference_bpm=None,
                  tempo_probs=None):
    """実測テンポのオクターブ誤り (半速/倍速) を複数の証拠で解消する。

    ビートトラッカーは 82.9 BPM の曲をそのまま返すことがある (例: KING は実際 165.8)。
    実測値と AI 推定値から半速/倍速/4倍と付点・3連系 (3:2 / 2:3) の候補を作り、
    次の証拠で採点する。

      1. ビート格子の強さ … オンセットを捉えている格子ほど高評価
      2. 格子が捉えたオンセット量 … 速すぎ/遅すぎを両方向に減点
      3. テンポ事前分布   … 120 BPM 付近を最も起こりやすいとする対数正規分布
      4. CLAP のテンポ感  … 英語プロンプトによる「速い/い」の印象 (任意)
      5. 参照BPM (AI推定) … 別のテンポ系列にあり、かつ証拠が拮抗しているときだけ採用

    証拠がまったく得られない場合 (無音など) は参照BPMへの単純な寄せ (align_tempo) に戻る。

    返り値: (bpm, diagnostics)
    """
    raw = _num(raw_bpm)
    ref = _num(reference_bpm)
    acf = onset_periodicity(onset_env, sr, hop_length)
    # 候補は実測値から作る (AI推定値は候補そのものにはせず、系列の選択にのみ使う。
    # AI推定の数値を候補に混ぜると、証拠が団子になったとき数値の一致だけで勝ってしまう)
    scored, added = [], []
    for cand in tempo_candidates(raw):
        refined, _fit = refine_tempo(onset_env, sr, hop_length, cand)
        if any(abs(refined - prev) < 0.5 for prev in added):
            continue
        added.append(refined)
        scored.append(tempo_evidence(onset_env, sr, hop_length, refined,
                                     tempo_probs, acf))
    scored.sort(key=lambda item: (-item[0], item[1]["bpm"]))
    if not scored or scored[0][0] <= 0.0:
        # どの候補も証拠が無い → 参照BPMに寄せるだけにする (旧動作との互換)
        fallback = align_tempo(raw, ref) if ref > 0 else raw
        method = "reference" if ref > 0 else "none"
        return fallback, {"bpm": round(fallback, 1), "method": method,
                          "candidates": [], "score_margin": 0.0}

    top = scored[0]
    method = "beat_track" if abs(top[1]["bpm"] - raw) < 0.5 else "octave"
    best_bpm, diagnostics = _adopt_reference(scored, top, ref, method)
    return best_bpm, diagnostics


def _adopt_reference(scored, top, ref, method):
    """参照BPM (AI推定) を採用するかどうかを決め、最終テンポと内訳を返す。

    採用条件 (すべて満たすときだけ):
      1. 参照BPMと一致する候補が存在する (誤差 TEMPO_REF_TOLERANCE 以内)
      2. その候補のスコアが首位の TEMPO_REF_MIN_SCORE_RATIO 以上 (証拠が拮抗している)
      3. その候補が首位と別のテンポ系列にある (TEMPO_REF_SAME_OCTAVE 以上離れている)
      4. 首位と2位の得点差が TEMPO_REF_MAX_MARGIN 未満 (ほぼ同点のときだけ)

    3 の条件が無いと、実測 143.6 に対して AI が 140 と言っただけで 140 に
    上書きされてしまい (同じテンポ系列内の数値の違い)、実測の精度が失われる。
    4 の条件が無いと、証拠が明確に一位の候補 (例: 166.3) があっても、
    AI 推定が近いだけの別候補 (例: 110.9) に奪われてしまう。
    参照BPMは「複数のテンポ系列が同点で並んだとき」の決め手としてのみ使う。
    """
    second = scored[1][0] if len(scored) > 1 else 0.0
    margin = (top[0] - second) / top[0] if top[0] > 0 else 0.0
    if ref > 0:
        ref_pick = min(scored, key=lambda item: abs(item[1]["bpm"] - ref))
        aligned = abs(ref_pick[1]["bpm"] - ref) <= TEMPO_REF_TOLERANCE * ref
        ratio_ok = ref_pick[0] >= top[0] * TEMPO_REF_MIN_SCORE_RATIO
        different_branch = abs(math.log2(
            max(1e-9, ref_pick[1]["bpm"]) / max(1e-9, top[1]["bpm"]))) >= TEMPO_REF_SAME_OCTAVE
        tied = margin < TEMPO_REF_MAX_MARGIN
        if aligned and ratio_ok and different_branch and tied:
            method = "reference"
            top = ref_pick
    diagnostics = {
        "bpm": round(float(top[1]["bpm"]), 1),
        "method": method,
        "candidates": [dict(item[1]) for item in scored[:3]],
        "score_margin": round(max(0.0, min(1.0, margin)), 3),
    }
    return float(top[1]["bpm"]), diagnostics


def tempo_confidence_from(diagnostics, pulse_clarity):
    """テンポ推定の確信度 (0..1)。パルス明瞭度と「首位と2位の得点差」から求める。"""
    clarity = _clamp01(_num(pulse_clarity) / 0.3)
    margin = _clamp01(_num((diagnostics or {}).get("score_margin")) / 0.5)
    return round(_clamp01(0.5 * clarity + 0.5 * margin), 3)


def align_tempo(measured, reference):
    """実測 BPM を AI 推定値へ寄せて補正する (証拠が無い場合のフォールバック)。

    measured の 1/2, 1, 2, 4 倍のうち reference に最も近い値を選ぶ。
    reference がどの候補からも大きく離れている場合は、AI 推定自体が疑わしいため
    measured をそのまま返す (以前は無条件に寄せていたため誤補正が起きていた)。
    通常の音源解析では証拠を伴う resolve_tempo() が判断する。
    """
    m = _num(measured)
    ref = _num(reference)
    if m <= 0 or ref <= 0:
        return m
    best, best_diff = m, abs(m - ref)
    for factor in TEMPO_CANDIDATE_FACTORS:
        cand = m * factor
        if not tempo_in_range(cand):
            continue
        diff = abs(cand - ref)
        if diff < best_diff:
            best, best_diff = cand, diff
    if best_diff > max(12.0, TEMPO_REF_TOLERANCE * ref):
        return m
    return best


def has_librosa():
    try:
        import librosa  # noqa: F401
        return True
    except Exception:
        return False


def has_clap():
    """laion-clap が使えるかどうか (未導入なら librosa のみで動く)。"""
    if os.environ.get("TUNEDROP_VIBE_ENGINE", "auto").strip() == "librosa":
        return False
    try:
        import laion_clap  # noqa: F401
        return True
    except Exception:
        return False


def engine_name():
    return "librosa+clap" if has_clap() else "librosa"


def _mode_scores(chroma):
    """クロマから長調らしさ・短調らしさを求める (12調のうち最も相関が高いもの)。"""
    import numpy as np

    major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                              2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                              2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    c = np.asarray(chroma, dtype="float64")
    if c.size != 12 or float(c.std()) < 1e-9:
        return 0.5, 0.5

    def best(profile):
        return max(float(np.corrcoef(c, np.roll(profile, i))[0, 1]) for i in range(12))

    try:
        return best(major_profile), best(minor_profile)
    except Exception:
        return 0.5, 0.5


def _beat_track(onset_env, sr, hop_length, bpm=None, start_bpm=120.0, tightness=100.0):
    """ビートトラック。bpm を指定できる librosa ではテンポを固定して拍を取る。

    返り値: (tempo_bpm, beat_frames)
    """
    import numpy as np
    import librosa

    kwargs = {"onset_envelope": onset_env, "sr": sr, "hop_length": hop_length,
              "tightness": tightness}
    if bpm:
        try:
            tempo_arr, frames = librosa.beat.beat_track(bpm=bpm, **kwargs)
            return float(np.atleast_1d(tempo_arr)[0]), frames
        except Exception:
            # bpm 引数を持たない古い librosa は start_bpm に読み替える
            kwargs["start_bpm"] = bpm
    else:
        kwargs["start_bpm"] = start_bpm
    tempo_arr, frames = librosa.beat.beat_track(**kwargs)
    return float(np.atleast_1d(tempo_arr)[0]), frames


def analyze_acoustics(y, sr, reference_tempo=None, tempo_probs=None):
    """librosa で音響統計量を抽出する (雰囲気特徴の原料)。

    テンポとビートは HPSS の打楽器成分 (percussive) のオンセット包絡から求める。
    歌声・旋律のオンセットに引っ張られにくくなり、ドラムの拍がはっきり取れる。
    半速/倍速/3:2 の誤りは resolve_tempo() が複数の証拠で解消する。
    reference_tempo (AI 推定 BPM) は別系列の候補が拮抗したときの決め手、
    tempo_probs (CLAP のテンポ感) は「速い/遅い」の印象として採点に使う。
    """
    import numpy as np
    import librosa

    hop = 512
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    rms = librosa.feature.rms(S=S)[0]
    duration = max(1e-6, len(y) / float(sr))
    rms_mean = float(rms.mean())
    rms_db = 20.0 * float(np.log10(max(rms_mean, 1e-6)))

    # HPSS を先に計算し、打楽器成分をビート解析へ回す
    harmonic, percussive = librosa.effects.hpss(y)
    total_power = float(np.sum(y ** 2)) + 1e-9
    harmonic_ratio = float(np.sum(harmonic ** 2) / total_power)
    percussive_ratio = float(np.sum(percussive ** 2) / total_power)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    beat_env = onset_env
    beat_env_source = "full"
    if percussive_ratio >= PERCUSSIVE_MIN_RATIO:
        beat_env = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=hop)
        beat_env_source = "percussive"

    tempo_raw, beat_frames = _beat_track(beat_env, sr, hop)
    tempo, tempo_info = resolve_tempo(beat_env, sr, hop, tempo_raw,
                                      reference_bpm=reference_tempo,
                                      tempo_probs=tempo_probs)
    if abs(tempo - tempo_raw) >= 0.5:
        # オクターブを補正したので、確定テンポで拍を取り直す (拍数・位置を揃える)
        _, beat_frames = _beat_track(beat_env, sr, hop, bpm=tempo)
    beat_times = [float(t) for t in
                  librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)]

    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop)
    onset_rate = float(len(onset_frames)) / duration

    pulse = librosa.beat.plp(onset_envelope=beat_env, sr=sr, hop_length=hop)
    pulse_clarity = float(np.mean(pulse))

    # ビート間隔のばらつきが小さいほど「規則的 = 踊りやすい」
    regularity = 0.5
    if len(beat_times) > 4:
        ibi = np.asarray(np.diff(beat_times), dtype="float64")
        ibi = ibi[(ibi > 0.15) & (ibi < 3.0)]
        if ibi.size:
            regularity = 1.0 - _clamp01((float(np.std(ibi)) / max(1e-6, float(np.mean(ibi)))) / 0.25)

    centroid = float(librosa.feature.spectral_centroid(S=S, sr=sr).mean())
    rolloff = float(librosa.feature.spectral_rolloff(S=S, sr=sr).mean())
    bandwidth = float(librosa.feature.spectral_bandwidth(S=S, sr=sr).mean())
    flatness = float(librosa.feature.spectral_flatness(S=S).mean())
    zcr = float(librosa.feature.zero_crossing_rate(y, hop_length=hop).mean())

    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr).mean(axis=1)
    chroma_sum = float(chroma.sum())
    if chroma_sum > 0:
        chroma = chroma / chroma_sum
    # メジャー/マイナー判定: クロマと長調/短調プロファイルの相関 (Krumhansl 風)
    major_score, minor_score = _mode_scores(chroma)

    # ボーカル帯域 (250-4000Hz) のエネルギー変動 → 歌ものらしさの代理指標
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    band = (freqs >= 250) & (freqs <= 4000)
    power = S ** 2
    vocal_band_db = librosa.power_to_db(power[band].sum(axis=0) + 1e-10)
    vocal_flux = float(np.std(vocal_band_db))
    band_ratio = float(power[band].sum() / max(1e-9, power.sum()))

    hf = freqs >= 6000
    hf_flatness = float(librosa.feature.spectral_flatness(S=S[hf]).mean())

    return {
        "rms_db": round(rms_db, 3),
        "onset_rate": round(onset_rate, 3),
        "tempo": round(tempo, 2),
        "tempo_raw": round(tempo_raw, 2),
        "tempo_method": tempo_info.get("method"),
        "tempo_candidates": tempo_info.get("candidates", []),
        "tempo_score_margin": tempo_info.get("score_margin"),
        "tempo_confidence": tempo_confidence_from(tempo_info, pulse_clarity),
        "beat_env": beat_env_source,
        "percussive_ratio": round(percussive_ratio, 4),
        "beat_times": [round(t, 3) for t in beat_times[:1200]],
        "pulse_clarity": round(pulse_clarity, 4),
        "regularity": round(regularity, 4),
        "centroid": round(centroid, 1),
        "rolloff": round(rolloff, 1),
        "bandwidth": round(bandwidth, 1),
        "flatness": round(flatness, 5),
        "zcr": round(zcr, 5),
        "harmonic_ratio": round(harmonic_ratio, 4),
        "major_score": round(major_score, 4),
        "minor_score": round(minor_score, 4),
        "vocal_flux": round(vocal_flux, 3),
        "band_ratio": round(band_ratio, 4),
        "hf_flatness": round(hf_flatness, 5),
        "duration": round(duration, 2),
    }


def vibe_features(a):
    """音響統計量 → 雰囲気特徴 (各 0..1)。

    すべて音源から直接計算するため、曲名からの推測ではなく実測ベースになる。
    各値の算出根拠:
      energy          : 平均音量(dBFS) とオンセット密度
      danceability    : パルス明確度 + ビート規則性 + 120BPM 付近への近さ
      valence         : 長調らしさ(メジャー3度とマイナー3度の比) + 明るさ + エネルギー
      acousticness    : 倍音成分の多さ(HPSS) + ノイズ成分の少なさ
      speechiness     : ゼロ交差率とスペクトル平坦度 (ラップ/語り)
      instrumentalness: ボーカル帯域(250-4000Hz)の変動が小さいほど高い
      liveness        : 高域ノイズフロア + ビートの不規則さ (歓声/残響の代理)
    """
    energy_base = _clamp01((a.get("rms_db", -40.0) + 38.0) / 33.0)
    energy = _clamp01(0.72 * energy_base
                      + 0.28 * _clamp01((a.get("onset_rate", 0.0) - 1.2) / 5.5))

    tempo = _num(a.get("tempo")) or 120.0
    tempo_fit = _clamp01(1.0 - abs(tempo - 122.0) / 85.0)
    danceability = _clamp01(0.45 * _clamp01(a.get("pulse_clarity", 0.0) / 0.25)
                            + 0.30 * a.get("regularity", 0.5)
                            + 0.25 * tempo_fit)

    brightness = _clamp01((a.get("centroid", 1500.0) - 1200.0) / 2600.0)
    mode = _clamp01((a.get("major_score", 0.0) - a.get("minor_score", 0.0)) * 2.0 + 0.5)
    valence = _clamp01(0.45 * mode + 0.35 * brightness + 0.20 * energy)

    acousticness = _clamp01(0.55 * a.get("harmonic_ratio", 0.4)
                            + 0.45 * (1.0 - _clamp01(a.get("flatness", 0.05) / 0.15)))

    # ラップ/語りの多い曲: ゼロ交差率が高く中域がノイジーで、パルスが不明瞭
    speechiness = _clamp01(0.40 * _clamp01((a.get("zcr", 0.09) - 0.09) / 0.12)
                           + 0.30 * _clamp01((a.get("flatness", 0.06) - 0.06) / 0.18)
                           + 0.30 * (1.0 - _clamp01(a.get("pulse_clarity", 0.0) / 0.25)))

    instrumentalness = _clamp01(0.70 * (1.0 - _clamp01((a.get("vocal_flux", 7.0) - 6.0) / 10.0))
                                + 0.30 * (1.0 - _clamp01((a.get("band_ratio", 0.5) - 0.35) / 0.40)))

    liveness = _clamp01(0.5 * _clamp01((a.get("hf_flatness", 0.1) - 0.05) / 0.40)
                        + 0.5 * (1.0 - a.get("regularity", 0.5)))

    return {
        "tempo": round(tempo, 1),
        "energy": round(energy, 3),
        "danceability": round(danceability, 3),
        "valence": round(valence, 3),
        "acousticness": round(acousticness, 3),
        "instrumentalness": round(instrumentalness, 3),
        "speechiness": round(speechiness, 3),
        "liveness": round(liveness, 3),
    }


def mood_from_features(f):
    """雰囲気特徴から mood ラベルを決める (CLAP 未導入時のフォールバック)。"""
    e = f.get("energy", 0.5)
    v = f.get("valence", 0.5)
    ac = f.get("acousticness", 0.5)
    if e > 0.72 and v >= 0.55:
        return "happy"
    if e > 0.72 and v < 0.35:
        return "aggressive"
    if e > 0.62:
        return "energetic"
    if v < 0.38 and e < 0.55:
        return "sad" if ac < 0.55 else "dark"
    if e < 0.42:
        return "calm" if v >= 0.45 else "dreamy"
    if v > 0.6:
        return "warm"
    return "dreamy" if ac > 0.6 else "energetic"


def vibe_tags(f):
    """UI 表示用の短いタグ (雰囲気の言語化)。"""
    tags = []
    tempo = f.get("tempo", 0)
    if tempo >= 150:
        tags.append("高速")
    elif tempo >= 105:
        tags.append("ミドル")
    else:
        tags.append("スロー")
    if f.get("energy", 0) > 0.65:
        tags.append("高エネルギー")
    elif f.get("energy", 1) < 0.4:
        tags.append("静か")
    if f.get("valence", 0.5) > 0.6:
        tags.append("明るい")
    elif f.get("valence", 0.5) < 0.4:
        tags.append("暗め")
    if f.get("acousticness", 0) > 0.6:
        tags.append("アコースティック")
    if f.get("instrumentalness", 0) > 0.6:
        tags.append("インスト")
    if f.get("danceability", 0) > 0.6:
        tags.append("ダンサブル")
    return tags


def feature_vector(f):
    """UMAP 用の 8次元ベクトル (ai_analyzer.FEATURE_KEYS と同じ順序)。"""
    return [
        round(_clamp01(_num(f.get("tempo")) / 200.0), 4),
        round(_clamp01(f.get("energy")), 4),
        round(_clamp01(f.get("danceability")), 4),
        round(_clamp01(f.get("valence")), 4),
        round(_clamp01(f.get("acousticness")), 4),
        round(_clamp01(f.get("instrumentalness")), 4),
        round(_clamp01(f.get("speechiness")), 4),
        round(_clamp01(f.get("liveness")), 4),
    ]


# ==========================================================
# CLAP (任意): 音声×テキスト類似度によるムード判定
# ==========================================================
_CLAP = {"model": None, "error": None, "ready": False, "attempts": 0,
         "text_cache": {}}

# ソフトマックスの温度。CLAP のコサイン類似度は 0.0x 程度しか差が無いため、
# 温度なし (1.0) では全ラベルがほぼ等確率、逆に小さすぎると1ラベルへ張り付いて
# 不安定になる。0.07 を既定にし TUNEDROP_CLAP_TEMPERATURE で調整できるようにする。
CLAP_TEMPERATURE = 0.07
# CLAP の「テンポ感」判定プロンプト (英語)。
# CLAP は BPM を直接測るモデルではないが、「速い/遅い」という曲全体の印象は
# 英語プロンプトとの類似度で判定できる。ドラムが薄い・打ち込みが細かいなどで
# ビート格子の証拠が弱い曲では、この印象が候補 (半速/倍速/3:2) 選びの決め手になる。
CLAP_TEMPO_PROMPTS = {
    "slow": "a slow song with a very slow tempo and sparse beats",
    "mid": "a mid-tempo song with a steady relaxed groove",
    "upbeat": "an upbeat song with a fast danceable tempo",
    "fast": "a very fast song with rapid energetic drums",
}
# 各テンポ感クラスの代表 BPM と、許容する広がり (オクターブ)。
CLAP_TEMPO_CENTERS = {"slow": 70.0, "mid": 110.0, "upbeat": 150.0, "fast": 185.0}
CLAP_TEMPO_SIGMA_OCTAVES = 0.5
# テンポ感の確率は coarse な印象なので、mood 判定より温度を高めて (なだらかに) する。
CLAP_TEMPO_TEMPERATURE_FLOOR = 0.2
# テンポ感を採点へ効かせる重み (0 = 無効 / 1 = ビート証拠と同じ重み)。
CLAP_TEMPO_WEIGHT = 0.35
# インスト判定を CLAP で上書きするのに必要な確率差 (0.5 からの隔たり)。
# 僅差のときは CLAP も判断できていないため、librosa の推定を残す。
CLAP_INSTRUMENTAL_MARGIN = 0.05
# モデル読み込みの再試行回数 (初回の重みダウンロード失敗など一時的な失敗対策)
CLAP_MAX_LOAD_ATTEMPTS = 2


def clap_status():
    """CLAP の状態を返す (UI/デバッグ用)。"""
    return {"available": has_clap(), "ready": _CLAP["ready"], "error": _CLAP["error"]}


def clap_temperature():
    """CLAP のソフトマックス温度を返す (TUNEDROP_CLAP_TEMPERATURE)。

    未設定は CLAP_TEMPERATURE (0.07)。"none"/"off"/負値 は温度なし (1.0) にする。
    """
    raw = os.environ.get("TUNEDROP_CLAP_TEMPERATURE", "").strip().lower()
    if raw in ("none", "off"):
        return 1.0
    if not raw:
        return CLAP_TEMPERATURE
    val = _num(raw, 0.0)
    return val if val > 0 else 1.0


def _load_clap():
    """CLAP モデルを遅延ロードする (初回のみ重みをダウンロード)。

    読み込みに失敗しても CLAP_MAX_LOAD_ATTEMPTS 回までは再試行する。
    以前は一度失敗するとエラーを保持したままになり、プロセスを再起動するまで
    (重みの一時的なダウンロード失敗でも) 永久に CLAP が使えなくなっていた。
    """
    if _CLAP["ready"]:
        return _CLAP["model"]
    attempts_limit = int(_num(os.environ.get("TUNEDROP_CLAP_RETRY"),
                              CLAP_MAX_LOAD_ATTEMPTS) or CLAP_MAX_LOAD_ATTEMPTS)
    attempts_limit = max(1, attempts_limit)
    if _CLAP["error"] is not None and _CLAP["attempts"] >= attempts_limit:
        return None
    if not has_clap():
        _CLAP["error"] = "laion-clap not installed"
        return None
    _CLAP["attempts"] += 1
    try:
        import laion_clap
        model = laion_clap.CLAP_Module(enable_fusion=False)
        ckpt = os.environ.get("TUNEDROP_CLAP_CKPT", "").strip()
        if ckpt:
            model.load_ckpt(ckpt)
        else:
            model.load_ckpt()   # 既定の重みを自動ダウンロード
        _CLAP["model"] = model
        _CLAP["ready"] = True
        _CLAP["error"] = None
        return model
    except Exception as exc:
        _CLAP["error"] = str(exc)[:200]
        return None


def _clap_has_mlayer(model):
    """ボーカル範囲検出つき (fusion) モデルかどうか。"""
    try:
        return bool(getattr(getattr(model, "clap", model), "mlayer", None))
    except Exception:
        return False


def _clap_text_features(model, prompts):
    """プロンプト集合のテキスト埋め込み (L2正規化済み, shape=(n, dim)) を返す。

    同じプロンプトの埋め込みは毎回同じなのでプロセス内でキャッシュする。
    以前は呼び出しごとにテキストエンコードし直していた (1曲あたり3回)。
    """
    import numpy as np

    key = tuple(prompts.values())
    cached = _CLAP["text_cache"].get(key)
    if cached is not None:
        return cached
    raw = np.asarray(model.get_text_embedding(list(prompts.values()), use_tensor=False),
                     dtype="float64")
    norms = np.linalg.norm(raw, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    normed = raw / norms
    _CLAP["text_cache"][key] = normed
    return normed


def _clap_embeddings(model, y, sr, clip_sec=10, max_clips=3):
    """CLAP 用の音声埋め込み (L2正規化済み) のリストを返す。

    CLAP の音声入力は 48kHz のため、必要なときだけ変換する。
    クリップごとに変換するのでメモリは増えない。
    """
    import numpy as np

    out = []
    for clip in _clap_clips(y, sr, clip_sec=clip_sec, max_clips=max_clips):
        arr = np.asarray(clip, dtype="float32").reshape(1, -1)
        if int(sr) != 48000:
            import librosa
            arr = librosa.resample(arr, orig_sr=sr, target_sr=48000, res_type="soxr_hq")
        emb = np.asarray(model.get_audio_embedding_from_data(x=arr, use_tensor=False),
                         dtype="float64").reshape(-1)
        norm = float(np.linalg.norm(emb)) if emb.size else 0.0
        if norm > 0:
            out.append(emb / norm)
    return out


def _clap_probs(embs, text_features, prompts, temperature):
    """クリップ単位でソフトマックスしてから平均した確率を返す (dict)。

    平均埋め込みを1回だけ確率化すると、外れクリップ (無音/間奏) の影響が
    そのまま出る。クリップごとに確率化して平均する方が安定する。
    """
    import numpy as np

    if not embs:
        return {}
    sims = np.asarray(embs, dtype="float64") @ np.asarray(text_features, dtype="float64").T
    shifted = sims - sims.max(axis=1, keepdims=True)
    exp = np.exp(shifted / max(1e-9, float(temperature)))
    per_clip = exp / exp.sum(axis=1, keepdims=True)
    mean = per_clip.mean(axis=0)
    return {name: round(float(v), 3) for name, v in zip(prompts.keys(), mean)}


def clap_scores(y, sr):
    """CLAP でムード確率とインストらしさを返す。使えない場合は None。

    サビ候補を含む 10秒 × 最大3区間の埋め込みを作り、プロンプト集合ごとに
    確率化する。ボーカル検出つきモデル (fusion) では vocal_proba も返す。
    各スコアの算出に失敗しても取れた分だけ返す (以前は1つ失敗すると全滅した)。
    """
    model = _load_clap()
    if model is None:
        return None
    try:
        temperature = clap_temperature()
        embs = _clap_embeddings(model, y, sr)
        if not embs:
            return None
        text_mood = _clap_text_features(model, CLAP_PROMPTS)
        mood_probs = _clap_probs(embs, text_mood, CLAP_PROMPTS, temperature)
        if not mood_probs:
            return None
        scores = {"mood": mood_probs, "clips": len(embs), "temperature": temperature}
        try:
            instr_probs = _clap_probs(embs, _clap_text_features(model, CLAP_INSTRUMENTAL_PROMPTS),
                                      CLAP_INSTRUMENTAL_PROMPTS, temperature)
            scores["instrumentalness"] = instr_probs.get("instrumental", 0.0)
            scores["clap_instrumentalness"] = instr_probs
        except Exception:
            pass
        try:
            # テンポ感 (slow/mid/upbeat/fast) は coarse な印象なので、
            # mood よりなだらかな分布になるよう温度に下限を設ける。
            tempo_temp = max(temperature, CLAP_TEMPO_TEMPERATURE_FLOOR)
            scores["tempo_probs"] = _clap_probs(
                embs, _clap_text_features(model, CLAP_TEMPO_PROMPTS),
                CLAP_TEMPO_PROMPTS, tempo_temp)
        except Exception:
            pass
        if _clap_has_mlayer(model):
            try:
                scores["vocal_proba"] = _clap_probs(
                    embs, _clap_text_features(model, CLAP_VOCAL_PROMPTS),
                    CLAP_VOCAL_PROMPTS, temperature)
            except Exception:
                pass
        return scores
    except Exception as exc:
        _CLAP["error"] = str(exc)[:200]
        return None


def resolve_instrumentalness(librosa_value, clap_value):
    """インストらしさの最終値を決める。

    CLAP の instrumental/vocal が僅差 (0.5 付近) のときは CLAP も判断できていない
    ため上書きせず、librosa の推定 (ボーカル帯域の変動など) を残す。
    以前は常に上書きしていたため、歌ものを「インスト」と誤判定することがあった。
    """
    clap_norm = _clamp01(clap_value)
    if abs(clap_norm - 0.5) < CLAP_INSTRUMENTAL_MARGIN:
        return round(_clamp01(librosa_value), 3)
    return round(clap_norm, 3)


def _clap_clips(y, sr, clip_sec=10, max_clips=3):
    """CLAP 埋め込み用に、曲を代表する短区間を切り出す。

    以前は「3秒 / 30% / 60%」の固定3点だったため、静かなイントロや間奏を
    拾うことがあった。1秒ごとの RMS でサビ候補 (最も鳴っている区間) を選び、
    曲全体をカバーする区間 (前半/中盤/終盤) も加えて、重複と無音区間を除く。
    """
    import numpy as np

    try:
        total = float(len(y)) / float(sr or SR)
    except Exception:
        return []
    array = np.asarray(y)
    window = float(clip_sec)
    if array.size == 0:
        return []
    if total <= window:
        return [array]

    span = max(0.0, total - window)
    starts = []
    # 1) サビ候補: 1秒ごとの RMS が最大の区間を中心に切る
    secs = int(total)
    rms_sec = np.array([
        float(np.sqrt(np.mean(array[i * sr:(i + 1) * sr] ** 2)))
        for i in range(secs)
    ], dtype="float64") if secs > 0 else np.zeros(0)
    if rms_sec.size:
        loud_sec = int(np.argmax(rms_sec))
        if float(rms_sec[loud_sec]) > 1e-3:      # ほぼ無音の曲では使わない
            starts.append(max(0.0, min(loud_sec - window / 2.0, span)))
    # 2) 曲全体のカバー (前半/中盤/終盤で雰囲気が変わる曲にも対応)
    starts.extend([span * 0.1, span * 0.5, span * 0.9] if span > 0 else [0.0])

    clips, used = [], []
    for start in starts:
        start = max(0.0, min(float(start), span))
        if any(abs(start - prev) < window * 0.6 for prev in used):
            continue
        s0 = int(start * sr)
        s1 = int(min(len(array), (start + window) * sr))
        clip = array[s0:s1]
        if clip.size <= sr:                      # 1秒未満は埋め込みが不安定
            continue
        if float(np.sqrt(np.mean(clip.astype("float64") ** 2))) < 1e-4 and used:
            continue                             # 無音区間は使わない (他に候補がある場合)
        used.append(start)
        clips.append(clip)
        if len(clips) >= max(1, int(max_clips)):
            break
    return clips or [array]


def chorus_segments(y, sr, count=3, window=24.0):
    """1秒ごとの RMS から盛り上がり区間 (サビ候補) を推定する。"""
    import numpy as np

    total_secs = int(len(y) // sr)
    if total_secs < 5:
        return []
    rms_sec = np.array([
        float(np.sqrt(np.mean(y[i * sr:(i + 1) * sr] ** 2)))
        for i in range(total_secs)
    ])
    if not np.any(rms_sec > 0.01):
        return []
    top = sorted(range(total_secs), key=lambda i: rms_sec[i], reverse=True)[:count]
    segs = []
    for sec in sorted(top):
        if rms_sec[sec] > 0.01:
            segs.append({"start": float(sec), "duration": float(window)})
    merged = []
    for s in segs:
        if merged and s["start"] <= merged[-1]["start"] + merged[-1]["duration"] + 5:
            merged[-1]["duration"] = s["start"] + s["duration"] - merged[-1]["start"]
        else:
            merged.append(dict(s))
    return merged[:count]


def analyze_wav(wav_path, reference_tempo=None, use_clap=None):
    """WAV 1ファイルを解析して結果 dict を返す (キャッシュ保存なし)。"""
    import librosa

    if not has_librosa():
        raise RuntimeError("librosa missing: pip install --user librosa")

    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    if y is None or len(y) == 0:
        raise RuntimeError("empty audio")

    # CLAP を先に評価し、そのテンポ感 (英語プロンプト類似度) を候補の採点へ渡す。
    # CLAP 未導入なら None で、従来どおりの判定になる。
    if use_clap is None:
        use_clap = has_clap()
    scores = clap_scores(y, sr) if use_clap else None
    tempo_probs = (scores or {}).get("tempo_probs") or None

    acoustics = analyze_acoustics(y, sr, reference_tempo=reference_tempo,
                                  tempo_probs=tempo_probs)
    feats = vibe_features(acoustics)

    # テンポは analyze_acoustics 内で確定している (証拠 + AI 推定の参照で補正済み)
    tempo = _num(acoustics.get("tempo")) or _num(feats.get("tempo"))
    tempo_raw = _num(acoustics.get("tempo_raw")) or tempo
    feats["tempo"] = round(tempo, 1)

    mood_probs = (scores or {}).get("mood") or None
    if mood_probs:
        mood = max(mood_probs.items(), key=lambda kv: kv[1])[0]
        # インスト判定は CLAP の方が信頼できるため上書きする。
        # ただし CLAP が僅差で決めた場合 (確信度が低い) は librosa の推定を残す。
        clap_instr = scores.get("instrumentalness")
        if clap_instr is not None:
            feats["instrumentalness"] = resolve_instrumentalness(
                feats.get("instrumentalness"), clap_instr)
    else:
        mood = mood_from_features(feats)

    beats = [{"start": t, "position": 1 if i % 4 == 0 else 2}
             for i, t in enumerate(acoustics.get("beat_times", []))]

    result = {
        "status": "ready",
        "engine": "librosa+clap" if scores else "librosa",
        "measured": True,
        "source": "audio",
        "duration": round(acoustics.get("duration", 0.0), 2),
        "tempo": round(tempo, 1),
        "tempo_raw": round(tempo_raw, 1) if tempo_raw else 0.0,
        "tempo_source": "audio",
        "tempo_method": acoustics.get("tempo_method"),
        "tempo_candidates": acoustics.get("tempo_candidates", []),
        "tempo_algo": analysis_cache.TEMPO_ALGO_VERSION,
        "tempo_confidence": acoustics.get("tempo_confidence", 0),
        "beats": beats,
        "chorus": chorus_segments(y, sr),
        "chords": [],
        "mood": mood,
        "vibe_tags": vibe_tags(feats),
        "vibe_scores": mood_probs,
        "vibe_clap": {"instrumentalness": (scores or {}).get("instrumentalness"),
                      "clap_instrumentalness": (scores or {}).get("clap_instrumentalness"),
                      "vocal_proba": (scores or {}).get("vocal_proba"),
                      "tempo_probs": (scores or {}).get("tempo_probs"),
                      "clips": (scores or {}).get("clips"),
                      "temperature": (scores or {}).get("temperature")},
        "feature_vector": feature_vector(feats),
        "audio_feature_vector": [round(v, 4) for v in _acoustic_vector(acoustics)],
        "acoustics": acoustics,
    }
    # 雰囲気特徴 (energy 等) は AI 推定値と同じキー名で返す
    for key in ("energy", "danceability", "valence", "acousticness",
                "instrumentalness", "speechiness", "liveness"):
        result[key] = feats[key]
    return result


def _acoustic_vector(a):
    """参考保存用の固定長ベクトル (16次元)。"""
    keys = ["rms_db", "onset_rate", "pulse_clarity", "regularity", "centroid",
            "rolloff", "bandwidth", "flatness", "zcr", "harmonic_ratio",
            "major_score", "minor_score", "vocal_flux", "band_ratio",
            "hf_flatness", "tempo"]
    return [_num(a.get(k)) for k in keys]


def analyze(video_id, db_path, force=False, reference_tempo=None, use_clap=None,
            save=True):
    """YouTube 音源を取得して librosa(+CLAP) で解析し、キャッシュへ保存する。

    force=False のときは audio_engine のあるキャッシュを再利用する。
    失敗しても例外を投げず、status="unavailable" と error を返す。
    """
    if not audio_download.VIDEO_ID_RE.match(video_id or ""):
        raise ValueError("Invalid YouTube video ID")

    if not force:
        hit = analysis_cache.read(db_path, video_id, ttl=analysis_cache.CACHE_TTL)
        if hit and hit.get("audio_engine"):
            return hit

    if not has_librosa():
        return {"status": "unavailable", "engine": "unavailable", "measured": False,
                "tempo": 0, "feature_vector": [],
                "error": "librosa 未導入: pip install --user librosa"}

    workdir = tempfile.mkdtemp(prefix="tunedrop-vibe-")
    try:
        wav, _duration = audio_download.download_wav(video_id, workdir, sample_rate=SR)
        result = analyze_wav(wav, reference_tempo=reference_tempo, use_clap=use_clap)
    except Exception as exc:
        return {"status": "unavailable", "engine": "unavailable", "measured": False,
                "tempo": 0, "feature_vector": [], "error": str(exc)[:300]}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if save:
        existing = analysis_cache.read(db_path, video_id) or {}
        merged = analysis_cache.write_merged(
            db_path, video_id, analysis_cache.audio_fields(existing, result))
        result = dict(result)
        for key in ("beats", "chorus", "chords"):
            if isinstance(merged.get(key), list) and len(merged[key]) > 50:
                result[key] = f"<{len(merged[key])} items cached>"
    return result


if __name__ == "__main__":
    import argparse
    import json as _json
    from pathlib import Path

    ap = argparse.ArgumentParser(description="librosa(+CLAP) で音源の雰囲気を解析")
    ap.add_argument("video_id", nargs="?", help="YouTube video ID")
    ap.add_argument("--wav", help="ローカル WAV を解析する")
    ap.add_argument("--db", default=str(Path(__file__).with_name("database.sqlite")))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-clap", action="store_true")
    ap.add_argument("--engine", action="store_true", help="利用可能エンジンを表示")
    args = ap.parse_args()

    if args.engine:
        print(_json.dumps({
            "librosa": has_librosa(),
            "clap": has_clap(),
            "engine": engine_name(),
            "clap_status": clap_status(),
        }, ensure_ascii=False, indent=1))
    elif args.wav:
        out = analyze_wav(args.wav, use_clap=not args.no_clap)
        out.pop("audio_feature_vector", None)
        print(_json.dumps(out, ensure_ascii=False, indent=1))
    elif args.video_id:
        out = analyze(args.video_id, args.db, force=args.refresh,
                      use_clap=not args.no_clap)
        out.pop("audio_feature_vector", None)
        print(_json.dumps(out, ensure_ascii=False, indent=1))
    else:
        ap.print_help()

