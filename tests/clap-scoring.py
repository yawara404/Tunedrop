#!/usr/bin/env python3
"""CLAP のスコア計算 (mood / instrumentalness) をスタブモデルで検証する。

laion-clap (と torch) を入れなくても、埋め込みの作り方・確率化・
テキスト埋め込みのキャッシュ・クリップ選定・インスト判定の上書きルールを
確認できるよう、CLAP モデルを差し替えて実行する。

修正のポイント:
  - クリップ選定を「3秒/30%/60% の固定3点」から「RMS 最大区間 (サビ候補) +
    全体カバー」に変更 (静かなイントロを拾わない)
  - ソフトマックス温度を TUNEDROP_CLAP_TEMPERATURE で調整可能にし、
    平均埋め込み1回ではなくクリップ単位で確率化して平均する
  - テキスト埋め込みをプロセス内キャッシュ (毎回エンコードしない)
  - instrumentalness は CLAP が僅差のとき上書きしない
  - モデル読み込み失敗時の再試行 (TUNEDROP_CLAP_RETRY)

実行: .venv/bin/python tests/clap-scoring.py
"""
import os
import pathlib
import sys
import types

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vibe_analyzer as va

SR = 48000          # CLAP の入力サンプルレート (librosa のリサンプルを通さない)
REAL_LOAD_CLAP = va._load_clap     # テスト中はスタブに差し替えるため控えておく
failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name} {detail}")


class StubModel:
    """laion_clap.CLAP_Module の代役。埋め込みを決め打ちで返す。"""

    def __init__(self, mood="happy", instrumental=0.9, mlayer=False, tempo="fast"):
        self.mood = mood
        self.instrumental = instrumental
        self.tempo = tempo
        self.dim = 16
        self.text_calls = 0
        self.audio_calls = 0
        if mlayer:
            # fusion モデル相当 (ボーカル検出あり)
            self.clap = types.SimpleNamespace(mlayer=object())

    def _text_vector(self, text):
        vec = np.zeros(self.dim)
        for index, name in enumerate(va.CLAP_PROMPTS):
            if text == va.CLAP_PROMPTS[name]:
                vec[index] = 1.0
        if text == va.CLAP_INSTRUMENTAL_PROMPTS["instrumental"]:
            vec[8] = 1.0
        if text == va.CLAP_INSTRUMENTAL_PROMPTS["vocal"]:
            vec[9] = 1.0
        if text in va.CLAP_VOCAL_PROMPTS.values():
            vec[10] = 1.0
        for index, name in enumerate(va.CLAP_TEMPO_PROMPTS):
            if text == va.CLAP_TEMPO_PROMPTS[name]:
                vec[12 + index] = 1.0
        return vec

    def get_text_embedding(self, texts, use_tensor=False):
        self.text_calls += 1
        return np.array([self._text_vector(t) for t in texts])

    def get_audio_embedding_from_data(self, x=None, use_tensor=False):
        self.audio_calls += 1
        vec = np.zeros(self.dim)
        vec[list(va.CLAP_PROMPTS).index(self.mood)] = 1.0
        vec[8] = self.instrumental
        vec[9] = 1.0 - self.instrumental
        vec[10] = 0.5
        vec[12 + list(va.CLAP_TEMPO_PROMPTS).index(self.tempo)] = 1.0
        return np.asarray([vec])


def make_audio(seconds=60, loud_from=20.0, loud_to=36.0):
    """指定区間だけ音量が大きいテスト音源 (正弦波 + 振幅包絡) を作る。"""
    n = int(seconds * SR)
    time = np.arange(n) / float(SR)
    gain = np.full(n, 0.05)
    gain[int(loud_from * SR):int(loud_to * SR)] = 0.8
    return (np.sin(2.0 * np.pi * 220.0 * time) * gain).astype("float32")


audio = make_audio()

print("[1] ソフトマックス温度の設定")
os.environ.pop("TUNEDROP_CLAP_TEMPERATURE", None)
check("未設定は既定値", va.clap_temperature() == va.CLAP_TEMPERATURE, va.clap_temperature())
os.environ["TUNEDROP_CLAP_TEMPERATURE"] = "none"
check("none は温度なし (1.0)", va.clap_temperature() == 1.0)
os.environ["TUNEDROP_CLAP_TEMPERATURE"] = "0.5"
check("数値はそのまま使う", va.clap_temperature() == 0.5)
os.environ["TUNEDROP_CLAP_TEMPERATURE"] = "abc"
check("不正値は温度なしにフォールバック", va.clap_temperature() == 1.0)
os.environ.pop("TUNEDROP_CLAP_TEMPERATURE", None)

print("[2] インスト判定は CLAP が僅差なら上書きしない")
check("僅差 (0.53) は librosa の値を残す", va.resolve_instrumentalness(0.2, 0.53) == 0.2)
check("僅差 (0.47) も残す", va.resolve_instrumentalness(0.7, 0.47) == 0.7)
check("明確 (0.9) は CLAP を採用", va.resolve_instrumentalness(0.2, 0.9) == 0.9)
check("明確 (0.1) も CLAP を採用", va.resolve_instrumentalness(0.8, 0.1) == 0.1)
check("librosa 側が無くてもれない", va.resolve_instrumentalness(None, 0.9) == 0.9)

print("[3] クリップ選定 (音量の大きい区間 = サビ候補を優先)")
clips = va._clap_clips(audio, SR)
check("クリップは 1..3 個", 1 <= len(clips) <= 3, len(clips))
check("各クリップは 10 秒以内", all(len(c) <= SR * 10 + 1 for c in clips),
      [len(c) for c in clips])
rms = [float(np.sqrt(np.mean(np.asarray(c, dtype="float64") ** 2))) for c in clips]
check("音量の大きい区間 (20〜36秒) を選ぶ", max(rms) > 0.4, rms)
check("静かなイントロだけにはならない", min(rms) > 0.01, rms)

print("[4] 短い音源はそのまま1クリップ")
short = make_audio(seconds=8)
short_clips = va._clap_clips(short, SR)
check("8秒の音源は1クリップ", len(short_clips) == 1 and len(short_clips[0]) == len(short),
      len(short_clips))
check("空の音源は空を返す", va._clap_clips(np.zeros(0, dtype="float32"), SR) == [])

print("[5] スタブモデルでのスコア計算")
stub = StubModel(mood="dark", instrumental=0.9)
va._load_clap = lambda: stub
scores = va.clap_scores(audio, SR)
check("mood はスタブどおり dark", max(scores["mood"], key=scores["mood"].get) == "dark",
      scores["mood"])
check("確率の合計は 1", abs(sum(scores["mood"].values()) - 1.0) < 0.02, scores["mood"])
check("instrumentalness は高い", scores["instrumentalness"] > 0.9, scores["instrumentalness"])
check("clips は 1..3", 1 <= scores["clips"] <= 3, scores["clips"])
check("温度を結果に残す", scores["temperature"] == va.CLAP_TEMPERATURE)
check("音声埋め込みはクリップ数だけ計算", stub.audio_calls == scores["clips"], stub.audio_calls)
check("vocal_proba は非対応モデルでは None", scores.get("vocal_proba") is None)
check("テンポ感 (tempo_probs) を返す", isinstance(scores.get("tempo_probs"), dict)
      and set(scores["tempo_probs"]) == set(va.CLAP_TEMPO_PROMPTS),
      scores.get("tempo_probs"))
check("スタブどおり fast が最大",
      max(scores["tempo_probs"], key=scores["tempo_probs"].get) == "fast",
      scores["tempo_probs"])

print("[6] テキスト埋め込みのキャッシュ (毎回エンコードしない)")
va._CLAP["text_cache"].clear()
stub.text_calls = 0
va.clap_scores(audio, SR)
first_calls = stub.text_calls
va.clap_scores(audio, SR)
check("プロンプト集合ごとに1回だけ計算", first_calls == 3, first_calls)
check("2曲目の解析ではエンコードしない", stub.text_calls == first_calls,
      (first_calls, stub.text_calls))

print("[7] 温度で確率の尖り方が変わる")
embeddings = va._clap_embeddings(stub, audio, SR)
text_features = va._clap_text_features(stub, va.CLAP_PROMPTS)
sharp = va._clap_probs(embeddings, text_features, va.CLAP_PROMPTS, 0.07)
flat = va._clap_probs(embeddings, text_features, va.CLAP_PROMPTS, 1.0)
check("温度が小さいほど最大確率が高い", max(sharp.values()) > max(flat.values()),
      (max(sharp.values()), max(flat.values())))
check("どちらも確率の合計は 1",
      abs(sum(sharp.values()) - 1.0) < 0.02 and abs(sum(flat.values()) - 1.0) < 0.02)

print("[8] クリップ単位の確率化と平均")
happy_index = list(va.CLAP_PROMPTS).index("happy")
sad_index = list(va.CLAP_PROMPTS).index("sad")
happy_vec = np.zeros(stub.dim)
happy_vec[happy_index] = 1.0
sad_vec = np.zeros(stub.dim)
sad_vec[sad_index] = 1.0
mixed = va._clap_probs([happy_vec, sad_vec], text_features, va.CLAP_PROMPTS, 0.07)
check("拮抗する2クリップは同じ確率", abs(mixed["happy"] - mixed["sad"]) < 0.02, mixed)
check("平均なので約 0.5", abs(mixed["happy"] - 0.5) < 0.02, mixed["happy"])
same = va._clap_probs([happy_vec], text_features, va.CLAP_PROMPTS, 0.07)
repeated = va._clap_probs([happy_vec] * 3, text_features, va.CLAP_PROMPTS, 0.07)
check("同じクリップの繰り返しは同じ確率", same == repeated, (same, repeated))

print("[9] ボーカル検出つきモデルは vocal_proba も返す")
stub_vocal = StubModel(mood="calm", instrumental=0.2, mlayer=True)
va._load_clap = lambda: stub_vocal
scores = va.clap_scores(audio, SR)
check("mood は calm", max(scores["mood"], key=scores["mood"].get) == "calm", scores["mood"])
check("instrumentalness は低い", scores["instrumentalness"] < 0.1, scores["instrumentalness"])
check("vocal_proba は4項目", isinstance(scores.get("vocal_proba"), dict)
      and len(scores["vocal_proba"]) == 4, scores.get("vocal_proba"))

print("[10] モデルが使えないときは None (librosa のみで動作)")
original_load_clap = REAL_LOAD_CLAP
va._load_clap = lambda: None
check("スコアは None", va.clap_scores(audio, SR) is None)
va._load_clap = original_load_clap

print("[11] モデル読み込みは上限まで再試行する (未導入・読込失敗でも復帰できる)")
va._CLAP.update({"model": None, "ready": False, "error": None, "attempts": 0})


class _BoomModule:
    """load_ckpt が必ず失敗する偽 laion_clap (環境に依存しない検証のため)。"""

    def __init__(self, *args, **kwargs):
        raise RuntimeError("stub load failure")


fake = types.ModuleType("laion_clap")
fake.CLAP_Module = _BoomModule
real_laion = sys.modules.get("laion_clap")
real_load_clap = va._load_clap       # 環境で本物が読めてしまわないよう差し替える
sys.modules["laion_clap"] = fake
va.has_clap = lambda: True           # 導入済みに見せかけ、読み込みだけ失敗させる
os.environ["TUNEDROP_CLAP_RETRY"] = "2"
check("1回目は試す", real_load_clap() is None and va._CLAP["attempts"] == 1,
      va._CLAP["attempts"])
check("2回目も再試行する", real_load_clap() is None and va._CLAP["attempts"] == 2,
      va._CLAP["attempts"])
check("上限に達したら試さない", real_load_clap() is None and va._CLAP["attempts"] == 2,
      va._CLAP["attempts"])
check("エラー内容を保持する", isinstance(va._CLAP["error"], str), va._CLAP["error"])
check("ready にならない", va._CLAP["ready"] is False)
if real_laion is not None:
    sys.modules["laion_clap"] = real_laion
else:
    sys.modules.pop("laion_clap", None)
os.environ.pop("TUNEDROP_CLAP_RETRY", None)

print("-" * 60)
if failures:
    print(f"FAILED: {failures}")
    sys.exit(1)
print("PASS: CLAP のスコア計算はクリップ選定・温度・キャッシュ・上書き規則どおりに動く。")