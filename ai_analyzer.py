#!/usr/bin/env python3
"""AI-based music feature estimation (音源ダウンロード不要).

ブックマークの「曲名・アーティスト・カテゴリ」をもとに Gemini API で
音楽特徴量 (tempo/energy/danceability/valence/acousticness/...) を推定し、
UMAP埋め込み用の固定長数値ベクトルに変換する。

これにより YouTube音源のダウンロード(yt-dlp)を一切使わずに、
ブックマーク登録時の数値付与を行える。

- GEMINI_API_KEY 設定時  → Gemini で推定 (engine: "gemini")
- 未設定時/失敗時        → カテゴリ由来の決定的ルールベース (engine: "rules")

注意: Gemini 3 系はデフォルトで「思考トークン」を消費するため、
maxOutputTokens が小さいと JSON が 1 文字も返らない (finishReason=MAX_TOKENS)。
そのため thinkingBudget=0 を指定し、maxOutputTokens も余裕を持たせている。
"""
import hashlib
import json
import math
import os
import random
import re
import time
import urllib.request
import urllib.error

from runtime_config import load_environment

load_environment()

# APIキーは環境変数から取得。Python起動時に非公開の .env を読み込みます。
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

# Gemini API (Legacy generateContent) REST エンドポイント
#   https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# モデルは上から順に試す。旧モデル (gemini-2.0-flash / gemini-1.5-flash / gemini-2.5-flash) は廃止済み。
GEMINI_MODELS = [m for m in [
    os.environ.get("GEMINI_MODEL", ""),
    "gemini-flash-latest",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-flash-lite-latest",
] if m]
# 出力トークン上限。思考トークン込みで消費されるため 256 では JSON が返らない。
GEMINI_MAX_TOKENS = int(os.environ.get("GEMINI_MAX_TOKENS", "1024") or "1024")
# thinkingBudget: 0 = 思考を無効化 (JSON出力を確実にする)。負値で指定なし。
GEMINI_THINKING_BUDGET = int(os.environ.get("GEMINI_THINKING_BUDGET", "0") or "0")
# 1モデルあたりの再試行回数 (429/503 の一時エラー対策)
GEMINI_RETRIES = int(os.environ.get("GEMINI_RETRIES", "2") or "2")
GEMINI_TIMEOUT = float(os.environ.get("GEMINI_TIMEOUT", "30") or "30")

# 生成させる固定キー。feature vector の次元を固定するために順序も固定。
FEATURE_KEYS = [
    "tempo",            # BPM (40..220)
    "energy",           # 0..1
    "danceability",     # 0..1
    "valence",          # 0..1
    "acousticness",     # 0..1
    "instrumentalness", # 0..1
    "speechiness",      # 0..1
    "liveness",         # 0..1
]
TEMPO_MAX = 200.0
MOODS = ["happy", "sad", "calm", "energetic", "dark", "dreamy", "aggressive", "warm"]

_CATEGORY_PROFILE = {
    "Vocaloid": dict(tempo=160, energy=0.82, danceability=0.80, valence=0.60,
                     acousticness=0.10, instrumentalness=0.05, speechiness=0.12, liveness=0.30),
    "J-POP":    dict(tempo=124, energy=0.68, danceability=0.62, valence=0.58,
                     acousticness=0.30, instrumentalness=0.02, speechiness=0.08, liveness=0.20),
    "Anime":    dict(tempo=150, energy=0.85, danceability=0.60, valence=0.66,
                     acousticness=0.15, instrumentalness=0.08, speechiness=0.10, liveness=0.28),
    "Lo-Fi":    dict(tempo=82,  energy=0.30, danceability=0.50, valence=0.45,
                     acousticness=0.80, instrumentalness=0.40, speechiness=0.05, liveness=0.12),
    "Other":    dict(tempo=120, energy=0.55, danceability=0.55, valence=0.50,
                     acousticness=0.40, instrumentalness=0.15, speechiness=0.08, liveness=0.18),
}


# ==========================================================
# ボカロ (Vocaloid) 判定
# ==========================================================
_VOCALOID_JP = [
    # 日本語表記のシンガー名 / 総称 (部分一致)
    "初音ミク", "鏡音リン", "鏡音レン", "巡音ルカ",
    "結月ゆかり", "重音テト", "音街ウナ", "歌愛ユキ",
    "神威がくぽ", "がくっぽいど", "鳴花ヒメ", "鳴花ミコト",
    "弦巻マキ", "猫村いろは", "東北ずん子",
    "洛天依", "言和", "心華", "星尘", "乐正绫", "乐正龙牙",
    "ボカロ", "ボーカロイド",
]

_VOCALOID_EN = [
    "hatsune miku", "kagamine rin", "kagamine len", "megurine luka",
    "yuzuki yukari", "kasane teto", "otomachi una", "kaai yuki",
    "camui gackpo", "gackpoid", "luo tianyi", "yan he", "xin hua",
    "meiko", "kaito", "gumi", "megpoid", "ia", "kafu",
    "vocaloid", "cevio", "synthesizer v", "utau",
]

_VOCALOID_EN_RE = re.compile(
    r"(?<![a-z0-9])(?:"
    + "|".join(re.escape(n) for n in _VOCALOID_EN)
    + r")(?![a-z0-9])"
)


def detect_vocaloid(title="", channel=""):
    """曲名・アーティストにボカロシンガー名などが含まれていれば True。"""
    text = " ".join([(title or ""), (channel or "")])
    if any(name in text for name in _VOCALOID_JP):
        return True
    return _VOCALOID_EN_RE.search(text.lower()) is not None


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _sanitize_value(v, key):
    """数値を各キーの適切な範囲へ丸める。"""
    try:
        f = float(v)
    except Exception:
        f = 0.0
    if math.isnan(f) or math.isinf(f):
        f = 0.0
    if key == "tempo":
        return round(_clamp(f, 40.0, 220.0), 1)
    return round(_clamp(f, 0.0, 1.0), 3)


def _guess_mood(vals):
    e = vals.get("energy", 0.5)
    va = vals.get("valence", 0.5)
    if e > 0.7 and va > 0.55:
        return "happy"
    if e > 0.7:
        return "energetic"
    if va < 0.4 and e < 0.5:
        return "sad"
    if e < 0.45:
        return "calm"
    if va > 0.6:
        return "warm"
    return "dreamy"


def _feature_vector(vals):
    """vals を UMAP 用の固定長ベクトル (8次元, 各 [0,1]) に正規化する。"""
    vec = []
    for k in FEATURE_KEYS:
        if k == "tempo":
            vec.append(round(_clamp(float(vals.get(k, 0) or 0) / TEMPO_MAX, 0.0, 1.0), 4))
        else:
            vec.append(round(_clamp(float(vals.get(k, 0) or 0), 0.0, 1.0), 4))
    return vec


def _rule_based(title, channel, category):
    """カテゴリ由来の特徴に、曲ごと決定的な揺らぎを載せて返す。"""
    base = dict(_CATEGORY_PROFILE.get(category, _CATEGORY_PROFILE["Other"]))
    seed = int(hashlib.md5((title + "\x00" + channel).encode("utf-8")).hexdigest(), 16) & 0x7FFFFFFF
    rnd = random.Random(seed)
    vals = {}
    for k in FEATURE_KEYS:
        v = base.get(k, 0.5) + rnd.uniform(-0.12, 0.12)
        vals[k] = _sanitize_value(v, k)
    return vals, _guess_mood(vals)


def _extract_json(text):
    """レスポンス文から JSON 部分を抜き出す。"""
    if not text:
        return {}
    text = text.strip().lstrip("\ufeff")
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        return {}
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return {}


def _build_prompt(title, channel, category):
    """Gemini へ渡すプロンプト。

    tempo は「その曲の公式/譜面として知られている BPM」を優先させる。
    例を示すことで、カテゴリ平均のような当たり障りのない値へ流れるのを防ぐ。
    """
    return (
        "You are a musicologist who knows official BPM data for songs. "
        "From the song information below ONLY (never download or listen to audio), "
        "estimate its audio features.\n"
        "For \"tempo\", answer the song's well-known official BPM (the value used in "
        "sheet music / DAW projects) as an integer, e.g. 紅蓮華=135, 秒針を噛む=120. "
        "Only if the BPM is unknown, give your best estimate. Do not round to 120/150 "
        "out of habit; use the actual groove of the song.\n"
        "Respond with a single JSON object, no markdown, no extra text. Keys exactly:\n"
        '{"tempo": <BPM 40-220>, "energy": <0-1>, "danceability": <0-1>, '
        '"valence": <0-1>, "acousticness": <0-1>, "instrumentalness": <0-1>, '
        '"speechiness": <0-1>, "liveness": <0-1>, '
        '"mood": <one of happy,sad,calm,energetic,dark,dreamy,aggressive,warm>}\n'
        f"Title: {title}\nArtist: {channel}\nCategory: {category}"
    )


def _gemini_generate(prompt, model, with_thinking_config=True):
    """1モデル・1回分の generateContent 呼び出し。テキストを返す。"""
    cfg = {"temperature": 0.2, "maxOutputTokens": GEMINI_MAX_TOKENS}
    if with_thinking_config and GEMINI_THINKING_BUDGET >= 0:
        cfg["thinkingConfig"] = {"thinkingBudget": GEMINI_THINKING_BUDGET}
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": cfg,
    }).encode("utf-8")
    req = urllib.request.Request(
        GEMINI_URL.format(model=model), data=body,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
        })
    with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT) as res:
        data = json.load(res)
    cand = (data.get("candidates") or [{}])[0]
    parts = cand.get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text.strip():
        finish = cand.get("finishReason") or "?"
        raise RuntimeError(f"empty response (finishReason={finish})")
    return text


def _call_gemini(title, channel, category):
    """Gemini で特徴量 JSON を取得する。失敗時は RuntimeError。

    - 思考トークンで出力が尽きないよう thinkingBudget=0 を指定
    - thinkingConfig 非対応モデル (HTTP 400) は指定なしで再試行
    - 429/503 などの一時エラーはバックオフして再試行し、次モデルへフォールバック
    """
    prompt = _build_prompt(title, channel, category)
    last_err = ""
    for model in GEMINI_MODELS:
        for attempt in range(GEMINI_RETRIES + 1):
            for with_thinking in (True, False):
                if not with_thinking and GEMINI_THINKING_BUDGET < 0:
                    continue
                try:
                    text = _gemini_generate(prompt, model, with_thinking)
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", "ignore")[:160]
                    last_err = f"HTTP {e.code} ({model}): {detail}"
                    if e.code in (400, 404) and with_thinking:
                        continue          # thinkingConfig 非対応 → 指定なしで再試行
                    break
                except Exception as e:
                    last_err = f"{model}: {str(e)[:160]}"
                    break
                parsed = _extract_json(text)
                if parsed and any(k in parsed for k in FEATURE_KEYS):
                    return parsed
                last_err = f"{model}: unparsable response {text[:120]!r}"
                break
            # 一時エラー (429/503/500) は少し待って再試行
            if attempt < GEMINI_RETRIES and ("HTTP 429" in last_err
                                             or "HTTP 503" in last_err
                                             or "HTTP 500" in last_err
                                             or "empty response" in last_err):
                time.sleep(min(2 ** attempt, 6))
                continue
            break
    raise RuntimeError("Gemini API call failed: " + last_err)



def analyze(title, channel, category):
    """曲情報から特徴量を推定し、feature_vector を含む dict を返す。

    返り値の主なキー:
      tempo         : BPM (Gemini 推定 or ルールベース)
      tempo_source  : "gemini" | "rules"  (BPM を誰が決めたか)
      engine        : "gemini" | "rules"  (特徴量全体の推定エンジン)
      category      : 判定カテゴリ (ボカロ検出 or プレイリスト由来)
      feature_vector: UMAP 用 8次元ベクトル (tempo は /200 で正規化)
    """
    title = (title or "").strip() or "Unknown"
    channel = (channel or "").strip() or "Unknown Artist"
    category = (category or "").strip() or "Other"

    # ボカロシンガー名などが含まれていれば、カテゴリを Vocaloid として扱う
    if detect_vocaloid(title, channel):
        category = "Vocaloid"

    # ルールベースは常に算出しておき、Gemini が欠けたキーの補完に使う
    rb, _rb_mood = _rule_based(title, channel, category)

    vals = {}
    engine = "rules"
    warn = None
    if GEMINI_API_KEY:
        try:
            vals = _call_gemini(title, channel, category)
            engine = "gemini"
        except Exception as exc:
            warn = str(exc)[:150]
            engine = "rules"

    tempo_source = "gemini" if engine == "gemini" else "rules"

    # 欠損・不正なキーをルールベースで補完 (tempo が 0/欠落なら BPM も rules 扱い)
    for k in FEATURE_KEYS:
        v = vals.get(k)
        if k == "tempo":
            try:
                valid = float(v) > 0
            except Exception:
                valid = False
            if not valid:
                vals[k] = rb[k]
                tempo_source = "rules"
        elif v is None:
            vals[k] = rb[k]

    cleaned = {k: _sanitize_value(vals.get(k), k) for k in FEATURE_KEYS}
    mood = (vals.get("mood") or "").strip().lower()
    if mood not in MOODS:
        mood = _guess_mood(cleaned)

    result = dict(cleaned)
    result.update({
        "mood": mood,
        "engine": engine,
        "tempo_source": tempo_source,
        "category": category,
        "feature_vector": _feature_vector(cleaned),
    })
    if warn:
        result["warn"] = warn
    return result


if __name__ == "__main__":
    import sys
    t = sys.argv[1] if len(sys.argv) > 1 else "秒針を噛む"
    c = sys.argv[2] if len(sys.argv) > 2 else "ずっと真夜中でいいのに。"
    cat = sys.argv[3] if len(sys.argv) > 3 else "J-POP"
    print(json.dumps(analyze(t, c, cat), ensure_ascii=False))
