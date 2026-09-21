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
import os
import shutil
import tempfile
import time

import analysis_cache
import audio_download

SR = 22050
MOODS = ["happy", "sad", "calm", "energetic", "dark", "dreamy", "aggressive", "warm"]

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


def align_tempo(measured, reference):
    """実測 BPM のオクターブ誤り (半速/倍速) を AI 推定値に寄せて補正する。

    ビートトラッカーは 82.9 BPM の曲をそのまま返すことがある (例: KING は実際 165.8)。
    measured の 1/2, 1, 2, 4 倍のうち reference (AI 推定 BPM) に最も近い値を選ぶ。
    reference が無効な場合は measured をそのまま返す。
    """
    m = _num(measured)
    ref = _num(reference)
    if m <= 0 or ref <= 0:
        return m
    best, best_diff = m, abs(m - ref)
    for factor in (0.5, 2.0, 4.0, 0.25):
        cand = m * factor
        if not (55.0 <= cand <= 210.0):
            continue
        diff = abs(cand - ref)
        if diff < best_diff:
            best, best_diff = cand, diff
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


def analyze_acoustics(y, sr):
    """librosa で音響統計量を抽出する (雰囲気特徴の原料)。"""
    import numpy as np
    import librosa

    hop = 512
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    rms = librosa.feature.rms(S=S)[0]
    duration = max(1e-6, len(y) / float(sr))
    rms_mean = float(rms.mean())
    rms_db = 20.0 * float(np.log10(max(rms_mean, 1e-6)))

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo_arr, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=hop)
    tempo = float(np.atleast_1d(tempo_arr)[0])
    beat_times = [float(t) for t in
                  librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)]

    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop)
    onset_rate = float(len(onset_frames)) / duration

    pulse = librosa.beat.plp(onset_envelope=onset_env, sr=sr, hop_length=hop)
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

    harmonic, _percussive = librosa.effects.hpss(y)
    total_power = float(np.sum(y ** 2)) + 1e-9
    harmonic_ratio = float(np.sum(harmonic ** 2) / total_power)

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
_CLAP = {"model": None, "error": None, "ready": False}


def clap_status():
    """CLAP の状態を返す (UI/デバッグ用)。"""
    return {"available": has_clap(), "ready": _CLAP["ready"], "error": _CLAP["error"]}


def _load_clap():
    """CLAP モデルを遅延ロードする (初回のみ重みをダウンロード)。"""
    if _CLAP["ready"]:
        return _CLAP["model"]
    if _CLAP["error"] is not None:
        return None
    if not has_clap():
        _CLAP["error"] = "laion-clap not installed"
        return None
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


def clap_scores(y, sr):
    """CLAP でムード確率とインストらしさを返す。使えない場合は None。

    イントロ/間奏/終盤から 10秒 × 最大3区間を切り出して埋め込み、平均する。
    ボーカル検出ありのモデルでは vocal_proba も返す。
    """
    model = _load_clap()
    if model is None:
        return None
    try:
        import numpy as np
        clips = _clap_clips(y, sr)
        if not clips:
            return None
        embs = []
        for clip in clips:
            arr = np.asarray(clip, dtype="float32").reshape(1, -1)
            if sr != 48000:
                import librosa
                arr = librosa.resample(arr, orig_sr=sr, target_sr=48000)
            emb = np.asarray(model.get_audio_embedding_from_data(x=arr, use_tensor=False),
                             dtype="float64")[0]
            n = float(np.linalg.norm(emb))
            if n > 0:
                embs.append(emb / n)
        if not embs:
            return None
        emb = np.mean(embs, axis=0)
        n = float(np.linalg.norm(emb))
        if n > 0:
            emb = emb / n

        def probs(prompts):
            text_emb = np.asarray(model.get_text_embedding(list(prompts.values()),
                                                           use_tensor=False),
                                  dtype="float64")
            sims = np.asarray([t / max(1e-9, float(np.linalg.norm(t))) for t in text_emb])
            sims = emb @ sims.T
            exp = np.exp((sims - sims.max()) / 0.07)   # 温度付きソフトマックス
            p = exp / float(exp.sum())
            return {name: round(float(v), 3) for name, v in zip(prompts.keys(), p)}

        mood_probs = probs(CLAP_PROMPTS)
        instr_probs = probs(CLAP_INSTRUMENTAL_PROMPTS)

        # ボーカル検出ありのモデルでは生の vocal 確率も返す
        vocal_proba = probs(CLAP_VOCAL_PROMPTS) if _clap_has_mlayer(model) else None

        return {"mood": mood_probs,
                "instrumentalness": instr_probs.get("instrumental", 0.0),
                "vocal_proba": vocal_proba,
                "clips": len(embs)}
    except Exception as exc:
        _CLAP["error"] = str(exc)[:200]
        return None


def _clap_clips(y, sr, clip_sec=10, max_clips=3):
    """CLAP 埋め込み用に、イントロ/本編/終盤から短区間を切り出す。"""
    try:
        total = float(len(y)) / float(sr or SR)
    except Exception:
        return []
    window = float(clip_sec)
    if total <= window * 1.5:
        return [y]
    bounds = [3.0, max(3.0, total * 0.3), max(3.0, total * 0.6)]
    clips = []
    for start in bounds[:max_clips]:
        if start >= total - 1.0:
            continue
        s0 = int(start * sr)
        s1 = int(min(len(y), (start + window) * sr))
        clip = y[s0:s1]
        if getattr(clip, "size", 0) and len(clip) > sr:
            clips.append(clip)
    return clips or [y]


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

    acoustics = analyze_acoustics(y, sr)
    feats = vibe_features(acoustics)

    # オクターブ誤り補正 (AI 推定 BPM があれば参照する)
    tempo_raw = _num(feats.get("tempo"))
    tempo = align_tempo(tempo_raw, reference_tempo) if reference_tempo else tempo_raw
    feats["tempo"] = round(tempo, 1)

    if use_clap is None:
        use_clap = has_clap()
    scores = clap_scores(y, sr) if use_clap else None
    mood_probs = (scores or {}).get("mood") or None
    if mood_probs:
        mood = max(mood_probs.items(), key=lambda kv: kv[1])[0]
        # インスト判定は CLAP の方が信頼できるので上書きする
        clap_instr = scores.get("instrumentalness")
        if clap_instr is not None:
            feats["instrumentalness"] = round(_clamp01(clap_instr), 3)
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
        "tempo_confidence": round(_clamp01(acoustics.get("pulse_clarity", 0.0) / 0.3), 3),
        "beats": beats,
        "chorus": chorus_segments(y, sr),
        "chords": [],
        "mood": mood,
        "vibe_tags": vibe_tags(feats),
        "vibe_scores": mood_probs,
        "vibe_clap": {"instrumentalness": (scores or {}).get("instrumentalness"),
                      "vocal_proba": (scores or {}).get("vocal_proba"),
                      "clips": (scores or {}).get("clips")},
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

