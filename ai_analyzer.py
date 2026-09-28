#!/usr/bin/env python3
"""AI-based music feature estimation (音源ダウンロード不要).

ブックマークの「曲名・アーティスト・カテゴリ」をもとに Gemini API で
音楽特徴量 (tempo/energy/danceability/valence/acousticness/...) を推定し、
UMAP埋め込み用の固定長数値ベクトルに変換する。

これにより YouTube音源のダウンロード(yt-dlp)を一切使わずに、
ブックマーク登録時の数値付与を行える。

- GEMINI_API_KEY 設定時  → Gemini で推定 (engine: "gemini")
- Gemini 失敗時/未設定時 → Ollama (ローカルLLM) で推定 (engine: "ollama")
- どちらも不可          → カテゴリ由来の決定的ルールベース (engine: "rules")
  (Gemini は課金クレジット切れで HTTP 402 を返すことがあるため、
   ローカルLLMへのフォールバックを用意している。TUNEDROP_AI_ENGINE で制御する)

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
import unicodedata
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

# ---- Ollama (ローカルLLM) ----
# Gemini が未設定/失敗したときの代替エンジン。ローカルで完結するため課金・レート制限がない。
#   TUNEDROP_AI_ENGINE: auto (既定 = gemini → ollama → rules) / gemini / ollama / rules
#   モデルは `ollama list` にあるもの。既定は qwen3:8b (約5.2GB)。
#   日本語のジャンル判定 (Vocaloid/J-POP/Anime 等) で gemma3:4b より高精度 (実測 12/13 vs 10/13)。
#   qwen3 は思考モデルのため think:false で思考を無効化して JSON を確実に返す。
AI_ENGINE = os.environ.get("TUNEDROP_AI_ENGINE", "auto").strip().lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b").strip()
OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "120") or "120")
OLLAMA_RETRIES = int(os.environ.get("OLLAMA_RETRIES", "1") or "1")
OLLAMA_NUM_PREDICT = int(os.environ.get("OLLAMA_NUM_PREDICT", "512") or "512")
# 思考モデル (qwen3 等) の思考を無効化する (JSON出力を確実にし高速化)。gemma3 等では無視される。
#   TUNEDROP_OLLAMA_THINK=1 で思考を有効化できる (既定 0 = 無効化)。
OLLAMA_THINK = os.environ.get("TUNEDROP_OLLAMA_THINK", "0").strip().lower() in ("1", "true", "yes", "on")

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
# 表示カテゴリ (frontend の CATEGORY_COLORS と同じ集合)
CATEGORIES = ("Vocaloid", "J-POP", "Anime", "Lo-Fi", "Other")

# LLM が返すジャンル表記の揺れを吸収するための別名
_CATEGORY_ALIASES = {
    "vocaloid": "Vocaloid", "ボカロ": "Vocaloid", "ボーカロイド": "Vocaloid",
    "jpop": "J-POP", "j-pop": "J-POP", "pop": "J-POP", "japanesepop": "J-POP",
    "anime": "Anime", "アニメ": "Anime", "anison": "Anime", "game": "Anime",
    "lofi": "Lo-Fi", "lo-fi": "Lo-Fi", "chill": "Lo-Fi",
    "other": "Other", "その他": "Other",
}


def normalize_category(value):
    """LLM が返したジャンルを既知の表示カテゴリへ寄せる (判定不能なら None)。"""
    text = str(value or "").strip()
    if not text:
        return None
    if text in CATEGORIES:
        return text
    key = text.lower().replace(" ", "").replace("_", "-")
    return _CATEGORY_ALIASES.get(key)


def normalize_vocal_type(value):
    """LLM の歌唱主体判定を人声/合成音声/インスト/不明へ揃える。"""
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "human": "human", "human_voice": "human", "human_vocal": "human",
        "singer": "human", "人声": "human", "人間": "human",
        "synthetic": "synthetic", "synth": "synthetic", "synthesized": "synthetic",
        "synthetic_voice": "synthetic", "voicebank": "synthetic", "合成音声": "synthetic",
        "instrumental": "instrumental", "none": "instrumental", "インスト": "instrumental",
        "unknown": "unknown", "不明": "unknown",
    }
    return aliases.get(key, "unknown")


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
    # 近年の合成音声 (CeVIO / Synthesizer V / VoiSona / VOICEVOX など)
    "可不", "星界", "花隈千冬", "冥鳴ひまり", "ナースロボ",
    "カゼヒキ", "名前シレズ", "ずんだもん", "春日部つむぎ",
    "東北きりたん", "波音リツ", "雨晴はう", "琴葉茜", "琴葉葵",
]

_VOCALOID_EN = [
    "hatsune miku", "kagamine rin", "kagamine len", "megurine luka",
    "yuzuki yukari", "kasane teto", "otomachi una", "kaai yuki",
    "camui gackpo", "gackpoid", "luo tianyi", "yan he", "xin hua",
    "meiko", "kaito", "gumi", "megpoid", "ia", "kafu", "flower", "vflower",
    "zundamon", "kazehiki",
    # ローマ字表記のボイスバンク名 (日本語表記が無い配信タイトルでも検出できるように)
    "hanakuma chifuyu", "namine ritsu", "tohoku kiritan",
    "kotonoha akane", "kotonoha aoi", "kasukabe tsumugi",
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


def _norm_key(s):
    """比較用の正規化 (NFKC + 小文字 + 記号/空白除去)。"""
    text = unicodedata.normalize("NFKC", str(s or ""))
    text = text.lower()
    return re.sub(r"[\s・'\"!?！？()（）\[\]【】「」『』,.、。…〜~\-_/／:：]", "", text)


# ボカロP (Vocaloid プロデューサー) のチャンネル名。曲名にボイスバンク名が明記されていない
# 曲でも、プロデューサー名から Vocaloid と判定できる (例: 「上書き / いよわ」)。
# あくまで「ほぼ Vocaloid 専業」のプロデューサーに限定し、誤判定を避ける。
_VOCALOID_PRODUCERS = [
    "deco*27", "sasakure", "iyowa", "いよわ",
    "r-906", "cosmo@暴走P", "暴走P",
    "はるまきごはん", "harumaki gohan", "椎乃味醂", "柊マグネタイト",
    "aqu3ra", "osanzi", "yunosuke", "雄之助", "一二三", "市瀬るぽ",
    "ぬゆり", "ピノキオピー", "pinocchiop", "八王子P", "みきとP", "mikitoP",
    "ナユタン星人", "nayutalien", "かいりきベア", "kairiki bear",
    "柊キライ", "煮ル果実", "香椎モイミ", "遼遼", "阿修", "凍傷のエト",
]


def detect_vocaloid_producer(channel=""):
    """チャンネル名が既知の Vocaloid プロデューサーなら True。"""
    text = _norm_key(channel)
    if not text:
        return False
    for name in _VOCALOID_PRODUCERS:
        key = _norm_key(name)
        if key and key in text:
            return True
    return False


_ANIME_RELEASE_MARKER_RE = re.compile(
    r"(?:アニメ(?:主題歌|op|ed|サイズ)|(?:tv|テレビ)アニメ|"
    r"(?:映画|劇場版|ゲーム)主題歌|"
    r"\b(?:anime\s+(?:opening|ending)|tv\s*size)\b|"
    r"\b(?:op|ed)(?:\s*(?:テーマ|主題歌|ver(?:sion)?|size))?\b)",
    re.IGNORECASE,
)
_LOFI_MARKER_RE = re.compile(
    r"(?:ローファイ|ローファイヒップホップ|チルホップ|"
    r"\blo[\s-]?fi\b|\bchill\s*hop\b)", re.IGNORECASE)


def explicit_metadata_category(title="", channel=""):
    """曲情報に明示されたジャンル手掛かりだけを返す。

    Anime は音のスタイルではなくタイアップ属性なので、曲名/配信タイトルに
    明示された作品・主題歌情報のみを使う。単なるアーティストの雰囲気からは
    推定せず、判定材料がなければ None を返して LLM の知識に委ねる。
    """
    if detect_vocaloid(title, channel):
        return "Vocaloid"
    if detect_vocaloid_producer(channel):
        return "Vocaloid"
    text = " ".join((title or "", channel or ""))
    if _ANIME_RELEASE_MARKER_RE.search(text):
        return "Anime"
    if _LOFI_MARKER_RE.search(text):
        return "Lo-Fi"
    return None


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
    ac = vals.get("acousticness", 0.5)
    if e > 0.7 and va >= 0.55:
        return "happy"
    if e > 0.72 and va < 0.35:
        return "aggressive"
    if e > 0.7:
        return "energetic"
    if va < 0.38 and e < 0.55:
        return "sad" if ac < 0.55 else "dark"
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
    """LLM (Gemini / Ollama) へ渡すプロンプト。

    tempo は「その曲の公式/譜面として知られている BPM」を優先させる。
    例を示すことで、カテゴリ平均のような当たり障りのない値へ流れるのを防ぐ。
    genre も答えさせる (プレイリストは複数ジャンルの曲を含むことがあり、
    リスト単位のカテゴリでは実態と合わないため。1曲ずつ判定して上書きに使う)。
    """
    return (
        "You are a musicologist who knows official BPM data for songs. "
        "From the song information below ONLY (never download or listen to audio), "
        "estimate its audio features.\n"
        "For \"tempo\", answer the song's official BPM (the value used in sheet music / "
        "DAW projects) as an integer.\n"
        "Calibrate your BPM scale with these real examples: 夜に駆ける=130, 紅蓮華=135, "
        "Tell Your World=140, 千本桜=154, メルト=170, Lemon=87, One Last Kiss=112, "
        "炎=152, 廻廻奇譚=185, アイドル=166.\n"
        "Vocaloid and J-pop songs have widely varying BPMs (85〜200); there is no single "
        "default. Output the exact BPM only if you actually know this specific song, "
        "otherwise output 0.\n"
        "For \"genre\", classify the song itself into exactly one of: "
        "Vocaloid, J-POP, Anime, Lo-Fi, Other.\n"
        "  - Vocaloid: only when a voice synthesizer sings (初音ミク, 可不, 歌愛ユキ, "
        "星界, flower, KAITO, GUMI, IA, 鏡音リン/レン, 巡音ルカ, 重音テト, Cevio/Synthesizer V/UTAU). "
        "A human singer never makes it Vocaloid.\n"
        "  - Anime: TVアニメ/ゲーム/映画の主題歌・挿入歌 (title has アニメ, TV size, ED, OP, 主題歌).\n"
        "  - J-POP: Japanese pop/rock performed by a human vocalist. Treat virtual performers, "
        "artist collectives, producers, and channel names as human artists unless the song's "
        "actual singing voice is a voicebank. Do not infer Vocaloid from an artist's aesthetic.\n"
        "  - Lo-Fi: chill/instrumental beats. Other: instrumental, classical, or unknown.\n"
        "If unsure between Vocaloid and J-POP, answer J-POP unless a voice synthesizer name is present.\n"
        "For \"mood\", judge the actual emotional tone of the song, not a genre stereotype. "
        "Upbeat songs can be sad or dark; slow songs can be warm. "
        "Do not default to happy/energetic.\n"
        "Respond with a single JSON object, no markdown, no extra text. Keys exactly:\n"
        '{"genre": <one of Vocaloid,J-POP,Anime,Lo-Fi,Other>, '
        '"tempo": <BPM 40-220>, "energy": <0-1>, "danceability": <0-1>, '
        '"valence": <0-1>, "acousticness": <0-1>, "instrumentalness": <0-1>, '
        '"speechiness": <0-1>, "liveness": <0-1>, '
        '"mood": <one of happy,sad,calm,energetic,dark,dreamy,aggressive,warm>}\n'
        f"Title: {title}\nArtist: {channel}\n"
        # プレイリストのカテゴリはあえて渡さない (「Vocaloid」を渡すと人間の曲まで
        # Vocaloid と答えるバイアスになる。判定は曲名とアーティストだけで行わせる)。
        "voice synthesizer name in the title/artist? "
        f"{'yes' if detect_vocaloid(title, channel) else 'no'}"
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


def _call_ollama(title, channel, category):
    """Ollama (ローカルLLM) で特徴量 JSON を取得する。失敗時は RuntimeError。

    - format="json" を指定して JSON 以外を出力させない (小型モデルでも parse できる)
    - temperature は低め (0.2) で、同じ曲なら毎回同じ値に寄せる
    - 接続不可 (Ollama 未起動・モデル未取得) はすぐ失敗させ、次のエンジンへ渡す
    """
    prompt = _build_prompt(title, channel, category)
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.2, "num_predict": OLLAMA_NUM_PREDICT},
    }
    if not OLLAMA_THINK:
        payload["think"] = False   # 思考モデル (qwen3) は思考を無効化して JSON を確実に返す
    body = json.dumps(payload).encode("utf-8")
    last_err = ""
    for attempt in range(OLLAMA_RETRIES + 1):
        try:
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/generate", data=body,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as res:
                data = json.load(res)
            text = (data.get("response") or "").strip()
            parsed = _extract_json(text)
            if parsed and any(k in parsed for k in FEATURE_KEYS):
                return parsed
            last_err = f"{OLLAMA_MODEL}: unparsable response {text[:120]!r}"
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:160]
            last_err = f"HTTP {e.code} ({OLLAMA_MODEL}): {detail}"
        except Exception as e:
            last_err = f"{OLLAMA_MODEL}: {str(e)[:160]}"
        if attempt < OLLAMA_RETRIES:
            time.sleep(min(2 ** attempt, 4))
    raise RuntimeError("Ollama API call failed: " + last_err)


# ジャンル専用の短いプロンプト。
# 特徴量と同時に聞くと小型モデルはジャンルを外しやすい (実測: 有名アニソン「紅蓮華」を
# Vocaloid と誤答)。ジャンルだけを聞くと精度が上がる (実測 8/9、1曲1〜3秒)。
_GENRE_PROMPT = (
    "You are classifying Japanese songs into a high-precision catalog category. "
    "First identify who/what is singing, then choose the category.\n"
    "Categories: Anime (TVアニメ/ゲーム/映画の主題歌・挿入歌), "
    "J-POP (人間の歌手のポップス/ロック), Vocaloid (合成音声が実際に歌う曲), Lo-Fi, Other.\n"
    "\n"
    "Rules:\n"
    "- Vocaloid は歌声合成ソフト/voicebank が実際の歌唱に使われている場合だけ。"
    "人間の歌手、バーチャルな外見/名義、ユニット名、プロデューサー名だけでは Vocaloid にしない。\n"
    "- アイドルマスター/学園アイドルマスター/プロジェクトセカイなどのキャラクター名義でも、"
    "実在の声優が歌っている楽曲は人間歌唱 (J-POP)。合成音声名 (初音ミク, 可不 等) が明示されていれば Vocaloid。\n"
    "- タイトルやアーティスト情報から歌唱主体を特定する。人間の歌唱と判断できたら、"
    "アニメ系の見た目や知名度に関係なく J-POP (タイアップが明記されていれば Anime)。\n"
    "- 合成音声だと確認できない場合、Vocaloid と推測せず vocal_type=unknown とする。\n"
    "- Anime は音の雰囲気ではなく、アニメ/ゲーム/映画との公式な tie-in カテゴリ。"
    "作品や主題歌との関係を知っている場合、またはタイトルに作品名/主題歌/挿入歌/TV size/OP/ED 等の明示がある場合に選ぶ。\n"
    "- アニメ風の音、アニメで有名な歌手、J-popアーティストというだけでは Anime にしない。"
    "タイアップを確認できなければ J-POP (人間歌唱) または Other。\n"
    "- Lo-Fi は実際に lo-fi / chillhop 系のビート。単にゆっくり/静かな曲なら Lo-Fi にしない。\n"
    "- アーティスト名と曲名から曲固有の情報を調べ、プレイリストのカテゴリや一般的な印象に引きずられない。"
    "確かな根拠がないときは Other。\n"
    "\n"
    "Calibration examples (these are ground truth; use them to anchor your judgment):\n"
    "- Anime: 紅蓮華(LiSA), 残酷な天使のテーゼ(高橋洋子), 群青讃歌(Eve), 廻廻奇譚(Eve), 炎(LiSA).\n"
    "- J-POP: Lemon(米津玄師), 夜に駆ける(YOASOBI), アイドル(YOASOBI), One Last Kiss(宇多田ヒカル).\n"
    "- Vocaloid: 千本桜(初音ミク), メルト(ryo feat.初音ミク), Tell Your World(kz feat.初音ミク).\n"
    "- Lo-Fi/Other: instrumental beats, classical, or electronic without a clear singer.\n"
    "\n"
    'Respond with JSON only: {"genre": "<Anime|J-POP|Vocaloid|Lo-Fi|Other>", '
    '"vocal_type": "<human|synthetic|instrumental|unknown>"}\n'
)


def _call_llm_genre(title, channel, engine):
    """ジャンルだけを LLM に聞く (engine: gemini / ollama)。失敗時は RuntimeError。"""
    prompt = _GENRE_PROMPT + f"Title: {title}\nArtist: {channel}"
    if engine == "gemini":
        last_err = ""
        for model in GEMINI_MODELS:
            try:
                return _extract_json(_gemini_generate(prompt, model, False))
            except Exception as exc:
                last_err = f"{model}: {str(exc)[:120]}"
        raise RuntimeError("Gemini genre call failed: " + last_err)

    return _ollama_json_call(prompt, temperature=0.1, num_predict=96)


# BPM 専用の短いプロンプト。特徴量と同時に聞くと、ボカロ曲が「140」に固まりやすい
# (実測: 未知のボカロ曲まで 140 と回答)。BPM だけを聞き、未知なら 0 を返させる。
_BPM_PROMPT = (
    "You are a musicologist who knows official BPM data. Output the song's official "
    "BPM (beats per minute) as an integer.\n"
    "Calibrate with these real BPMs: 夜に駆ける=130, 紅蓮華=135, Tell Your World=140, "
    "千本桜=154, メルト=170, Lemon=87, One Last Kiss=112, 炎=152, 廻廻奇譚=185, アイドル=166.\n"
    "Vocaloid and J-pop songs have widely varying BPMs (85〜200); there is no single default. "
    "Output the exact BPM only if you actually know this specific song, otherwise output 0.\n"
    'Respond with JSON only: {"tempo": <integer or 0>}\n'
)


def _call_llm_bpm(title, channel, engine):
    """BPM だけを LLM に聞く (engine: gemini / ollama)。不明なら 0。失敗時は RuntimeError。"""
    prompt = _BPM_PROMPT + f"Title: {title}\nArtist: {channel}"
    if engine == "gemini":
        last_err = ""
        for model in GEMINI_MODELS:
            try:
                return _extract_json(_gemini_generate(prompt, model, False))
            except Exception as exc:
                last_err = f"{model}: {str(exc)[:120]}"
        raise RuntimeError("Gemini BPM call failed: " + last_err)
    return _ollama_json_call(prompt, temperature=0.1, num_predict=48)


def _ollama_json_call(prompt, temperature=0.3, num_predict=256):
    """Ollama に任意の prompt を送り、JSON dict を返す (think:false, format=json)。"""
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {"temperature": temperature, "num_predict": num_predict},
    }
    if not OLLAMA_THINK:
        payload["think"] = False   # 思考モデル (qwen3) は思考を無効化して JSON を確実に返す
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate", data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as res:
        text = (json.load(res).get("response") or "").strip()
    return _extract_json(text)


def recommend_recipe(profile_text):
    """Ollama に好みプロファイルから推薦レシピ (優先ジャンル/ムード/テンポ等) を出させる。

    失敗時や判定不能時は None を返す (呼び出し側で分布上位を既定値にフォールバック)。
    """
    prompt = (
        "You are a music curator. From the user's collection taste profile below, "
        "decide what to prioritize for recommendations.\n"
        "Taste profile:\n" + str(profile_text) + "\n\n"
        "Respond with JSON only, no markdown. Keys exactly:\n"
        '{"taste": "<1行の好みの説明(日本語)>", '
        '"prefer_genres": [<好むジャンルを優先順に最大5, Vocaloid/J-POP/Anime/Lo-Fi/Other から>], '
        '"prefer_moods": [<好むムードを優先順に最大5, happy/sad/calm/energetic/dark/dreamy/aggressive/warm から>], '
        '"tempo": "<slow|mid|fast|any>", "energy": "<low|mid|high|any>", '
        '"valence": "<low|mid|high|any>"}\n'
    )
    try:
        recipe = _ollama_json_call(prompt)
        if isinstance(recipe, dict) and recipe.get("prefer_genres"):
            return recipe
    except Exception:
        pass
    return None


def analyze(title, channel, category):
    """曲情報から特徴量を推定し、feature_vector を含む dict を返す。

    返り値の主なキー:
      tempo         : BPM (Gemini / Ollama 推定 or ルールベース)
      tempo_source  : "gemini" | "ollama" | "rules"  (BPM を誰が決めたか)
      engine        : "gemini" | "ollama" | "rules"  (特徴量全体の推定エンジン)
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
    # 使うエンジンの順番を決める (TUNEDROP_AI_ENGINE で固定もできる)
    #   auto   : gemini (キーがあれば) → ollama
    #   gemini : gemini だけ / ollama : ollama だけ / rules : LLMを使わない
    order = []
    if AI_ENGINE == "auto":
        if GEMINI_API_KEY:
            order.append("gemini")
        order.append("ollama")
    elif AI_ENGINE == "gemini" and GEMINI_API_KEY:
        order.append("gemini")
    elif AI_ENGINE == "ollama":
        order.append("ollama")
    failures = []
    for name in order:
        try:
            vals = _call_gemini(title, channel, category) if name == "gemini" \
                else _call_ollama(title, channel, category)
            engine = name
            break
        except Exception as exc:
            failures.append(f"{name}: {str(exc)[:120]}")
            engine = "rules"
    if failures:
        warn = " / ".join(failures)[:150]

    tempo_source = engine if engine in ("gemini", "ollama") else "rules"

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
    # BPM は専用の短いプロンプトで聞き直す (特徴量と同時に聞くとボカロ曲が「140」に固まる)。
    # 明確に分かる曲だけ採用し、不明 (0) ならルールベースのばらついた値へ戻す。
    if engine in ("gemini", "ollama"):
        try:
            bpm = int(float((_call_llm_bpm(title, channel, engine) or {}).get("tempo") or 0))
            if 40 <= bpm <= 220:
                cleaned["tempo"] = _sanitize_value(bpm, "tempo")
                tempo_source = engine
            else:
                cleaned["tempo"] = _sanitize_value(rb["tempo"], "tempo")
                tempo_source = "rules"
        except Exception:
            pass   # 失敗時は feature 呼び出しの tempo をそのまま使う
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
    # LLM が曲ごとに判定したジャンル (表示カテゴリの上書きに使う)。
    # プレイリスト単位のカテゴリは、複数ジャンルを混ぜたリストでは実態と合わないため。
    ai_category = normalize_category(vals.get("genre")) if engine in ("gemini", "ollama") else None
    vocal_type = "unknown"
    # ジャンルは専用の短いプロンプトで聞き直す (特徴量と同時に聞くと外しやすい)。
    # 取れなかったときは上の値 (同時推定の genre) をそのまま使う。
    if engine in ("gemini", "ollama"):
        try:
            genre_result = _call_llm_genre(title, channel, engine) or {}
            focused = normalize_category(genre_result.get("genre"))
            vocal_type = normalize_vocal_type(genre_result.get("vocal_type"))
            if focused:
                ai_category = focused
        except Exception:
            pass
    # 曲名/配信タイトルにジャンルを明示した手掛かりがある場合は LLM より優先する。
    # 特に Anime は音楽スタイルとタイアップ属性を混同しやすいため、明示的な
    # リリース情報を判定に使う。合成音声の歌手名は確定情報として最優先。
    metadata_category = explicit_metadata_category(title, channel)
    if metadata_category:
        ai_category = metadata_category
    # 個別アーティスト名の例外リストではなく、歌唱主体の一般判定で補正する。
    elif ai_category == "Vocaloid" and vocal_type == "human":
        ai_category = "J-POP"
    elif vocal_type == "synthetic":
        ai_category = "Vocaloid"
    if vocal_type != "unknown":
        result["vocal_type"] = vocal_type
    if ai_category:
        result["ai_category"] = ai_category
    if warn:
        result["warn"] = warn
    return result


if __name__ == "__main__":
    import sys
    t = sys.argv[1] if len(sys.argv) > 1 else "秒針を噛む"
    c = sys.argv[2] if len(sys.argv) > 2 else "ずっと真夜中でいいのに。"
    cat = sys.argv[3] if len(sys.argv) > 3 else "J-POP"
    print(json.dumps(analyze(t, c, cat), ensure_ascii=False))
