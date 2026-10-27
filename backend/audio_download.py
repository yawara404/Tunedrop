#!/usr/bin/env python3
"""YouTube 音源の取得 (yt-dlp + ffmpeg) 共有モジュール。

vibe_analyzer (librosa/CLAP) から使う。
YouTube は web クライアントで SABR / PO Token を要求するため、
PO Token 不要でも muxed 形式が残るクライアントを順に試す。

環境変数 (任意):
    YTDLP_PO_TOKEN            : "web.gvs+XXX" 等の PO Token
    YTDLP_VISITOR_DATA        : PO Token と対になる visitorData
    YTDLP_COOKIES             : cookies.txt のパス
    YTDLP_COOKIES_FROM_BROWSER: chrome / safari / brave など
"""
import os
import re
import shutil
import subprocess

from runtime_config import load_environment

load_environment()

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# 試す順番。android は PO Token 無しでも muxed(18) が残ることが多い。
PLAYER_CLIENTS = ["android", "web_safari", "android_vr", "mweb", "tv", "web", "default"]


def find_ytdlp():
    """yt-dlp 実行体を解決する。PATH → ユーザーsite bin → 既知パス の順。"""
    exe = shutil.which("yt-dlp")
    if exe:
        return exe
    import site
    for base in (site.getusersitepackages(), site.getuserbase()):
        if not base:
            continue
        candidate = os.path.join(base, "bin", "yt-dlp")
        if os.path.isfile(candidate):
            return candidate
    home = os.path.expanduser("~")
    guess = os.path.join(home, "Library", "Python", "3.9", "bin", "yt-dlp")
    if os.path.isfile(guess):
        return guess
    return None


def find_src(workdir):
    """ダウンロード済みファイル (src.*) のパスを返す (無ければ None)。

    不完全な .part ファイルは対象外 (.part はダウンロード失敗時の中間物)。
    """
    try:
        for name in sorted(os.listdir(workdir)):
            if name.startswith("src.") and not name.endswith(".part"):
                return os.path.join(workdir, name)
    except Exception:
        pass
    return None


def _extra_options():
    """環境変数で指定された PO Token / Cookie オプションを組み立てる。"""
    opts = []
    po_token = os.environ.get("YTDLP_PO_TOKEN", "").strip()
    visitor = os.environ.get("YTDLP_VISITOR_DATA", "").strip()
    if po_token:
        opts += ["--extractor-args", "youtube:po_token=" + po_token]
    if visitor:
        opts += ["--extractor-args", "youtube:visitor_data=" + visitor]
    if os.environ.get("YTDLP_COOKIES"):
        opts += ["--cookies", os.environ["YTDLP_COOKIES"]]
    elif os.environ.get("YTDLP_COOKIES_FROM_BROWSER"):
        opts += ["--cookies-from-browser", os.environ["YTDLP_COOKIES_FROM_BROWSER"]]
    return opts


def download_wav(video_id, workdir, sample_rate=22050, timeout=240):
    """YouTube 音源を取得してモノラル WAV に変換する。

    戻り値: (wav_path, duration_sec)
    失敗時は RuntimeError (試した全クライアントのエラーを含む)。
    """
    ytdlp = find_ytdlp()
    ffmpeg = shutil.which("ffmpeg")
    if not ytdlp:
        raise RuntimeError("yt-dlp missing: pip install --user yt-dlp")
    if not ffmpeg:
        raise RuntimeError("ffmpeg missing: brew install ffmpeg")

    url = "https://www.youtube.com/watch?v=" + video_id
    raw = workdir + "/src.%(ext)s"
    extra = _extra_options()
    duration = 0.0
    last_err = ""

    for client in PLAYER_CLIENTS:
        args = ([] if client == "default"
                else ["--extractor-args", "youtube:player_client=" + client])
        # 注意: --print は --simulate を暗黙で有効にするため --no-simulate が必須。
        # これが無いとファイルが保存されず解析が必ず失敗する。
        cmd = [ytdlp, "--no-playlist", "--quiet", "--no-simulate",
               "-f", "bestaudio/best", "--print", "%(duration)s",
               "--retries", "3", "--fragment-retries", "3", "--retry-sleep", "2",
               "--socket-timeout", "30",
               "-o", raw] + args + extra + [url]
        # クライアント切替時は不完全ファイル (.part) を消して最初から試す
        for stale in ("src.mp4.part", "src.webm.part", "src.m4a.part"):
            try:
                stale_path = os.path.join(workdir, stale)
                if os.path.exists(stale_path):
                    os.remove(stale_path)
            except Exception:
                pass
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            last_err = f"{client}: download timeout"
            continue
        if p.returncode != 0:
            last_err = f"{client}: " + (p.stderr or "download failed").strip()[-200:]
            continue
        try:
            duration = float((p.stdout or "0").strip().splitlines()[-1])
        except Exception:
            duration = 0.0
        if find_src(workdir):
            break
        last_err = f"{client}: audio file not produced"

    src = find_src(workdir)
    if not src:
        raise RuntimeError("audio download failed: " + last_err)

    wav = os.path.join(workdir, "audio.wav")
    conv = subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", src,
         "-ac", "1", "-ar", str(sample_rate), wav],
        capture_output=True, text=True, timeout=timeout)
    if conv.returncode != 0:
        raise RuntimeError("ffmpeg convert failed: " + (conv.stderr or "")[-200:])
    return wav, duration
