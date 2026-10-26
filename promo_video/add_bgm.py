"""オリジナルBGMを合成して動画に付ける (著作権フリー)。

使い方: .venv/bin/python promo_video/add_bgm.py
入力  : tunedrop_radar_promo.mp4 / tunedrop_radar_promo_landscape.mp4
出力  : *_audio.mp4
"""
import os
import subprocess
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 44100
BPM = 112
BEAT = 60 / BPM
# Am - F - C - G (1小節 = 4拍)
CHORDS = [
    [57, 60, 64],   # Am: A3 C4 E4
    [53, 57, 60],   # F : F3 A3 C4
    [48, 52, 55],   # C : C3 E3 G3
    [55, 59, 62],   # G : G3 B3 D4
]
BASS = [45, 41, 36, 43]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tone(freq, dur, kind="tri", vol=1.0, atk=0.01, rel=0.2):
    n = int(SR * dur)
    t = np.arange(n) / SR
    if kind == "tri":
        w = 2 / np.pi * np.arcsin(np.sin(2 * np.pi * freq * t))
    elif kind == "saw":
        w = 2 * ((freq * t) % 1) - 1
    else:
        w = np.sin(2 * np.pi * freq * t)
    env = np.minimum(1, t / atk) * np.exp(-t / rel)
    return w * env * vol


def add(buf, sig, start):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def render(total):
    buf = np.zeros(int(SR * total))
    bar = BEAT * 4
    nbars = int(total / bar) + 1
    rng = np.random.default_rng(1)
    for b in range(nbars):
        t0 = b * bar
        ch = CHORDS[b % 4]
        # パッド (ゆったり)
        for m in ch:
            add(buf, tone(hz(m), bar * 1.05, "saw", 0.05, atk=0.25, rel=1.6), t0)
            add(buf, tone(hz(m + 12), bar * 1.05, "sin", 0.05, atk=0.25, rel=1.6), t0)
        # ベース
        for k in range(4):
            add(buf, tone(hz(BASS[b % 4]), BEAT * 0.9, "sin", 0.32, atk=0.005, rel=0.35), t0 + k * BEAT if k % 2 == 0 else t0 + k * BEAT + BEAT * 0.5)
        # アルペジオ (8分)
        for k in range(8):
            m = ch[[0, 1, 2, 1, 0, 1, 2, 1][k]] + 12
            add(buf, tone(hz(m), BEAT * 0.5, "tri", 0.13, atk=0.004, rel=0.18), t0 + k * BEAT / 2)
        # メロディ (2小節に1回、シンプルなモチーフ)
        if b % 2 == 1:
            motif = [(76, 0), (79, 1), (77, 2), (76, 2.5), (72, 3)]
            for m, pos in motif:
                add(buf, tone(hz(m + (b % 4 > 1) * -2), BEAT * 0.9, "sin", 0.12, atk=0.01, rel=0.4), t0 + pos * BEAT)
        # キック・ハット (序盤4小節はハットなし)
        for k in range(4):
            tt = np.arange(int(SR * 0.25)) / SR
            f = 50 + 110 * np.exp(-tt * 30)
            kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 12) * 0.5
            add(buf, kick, t0 + k * BEAT)
        if b >= 2:
            for k in range(8):
                n = int(SR * 0.05)
                hat = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 90) * 0.04
                add(buf, hat, t0 + k * BEAT / 2 + BEAT / 4)
    # フェードイン/アウト
    fi, fo = int(SR * 1.5), int(SR * 3.0)
    buf[:fi] *= np.linspace(0, 1, fi)
    buf[-fo:] *= np.linspace(1, 0, fo)
    buf = buf / (np.max(np.abs(buf)) + 1e-9) * 0.7
    return (buf * 32767).astype(np.int16)


def duration(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path])
    return float(out)


def main():
    for name in ["tunedrop_radar_promo", "tunedrop_radar_promo_landscape"]:
        src = os.path.join(HERE, name + ".mp4")
        if not os.path.exists(src):
            continue
        d = duration(src)
        wav = os.path.join(HERE, "bgm.wav")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(render(d).tobytes())
        out = os.path.join(HERE, name + "_audio.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-i", src, "-i", wav, "-map", "0:v", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out,
        ], check=True)
        os.remove(wav)
        print("done", out)


if __name__ == "__main__":
    main()
