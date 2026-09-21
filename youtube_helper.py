#!/usr/bin/env python3
"""TuneDrop YouTube helper: Data API v3 with oEmbed/noembed fallback (no key required)."""
import json
import os
import re
import urllib.parse
import urllib.request

from runtime_config import load_environment

load_environment()

# APIキーは環境変数から取得。Python起動時に非公開の .env を読み込みます。
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def is_video_id(value: str) -> bool:
    return bool(VIDEO_ID_RE.match(value or ""))


def _http_get_json(url: str, timeout: int = 8):
    req = urllib.request.Request(url, headers={"User-Agent": "TuneDrop/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def oembed_meta(video_id: str) -> dict:
    """Fallback metadata without API key (oEmbed + noembed)."""
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    for endpoint in [
        "https://www.youtube.com/oembed?url=" + urllib.parse.quote(watch_url, safe=""),
        "https://noembed.com/embed?url=" + urllib.parse.quote(watch_url, safe=""),
    ]:
        try:
            data = _http_get_json(endpoint)
            if data and data.get("title"):
                return {
                    "youtube_id": video_id,
                    "title": data.get("title", ""),
                    "channel": data.get("author_name", "Unknown Artist"),
                    "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                    "source": "oembed",
                }
        except Exception:
            continue
    return {
        "youtube_id": video_id,
        "title": video_id,
        "channel": "Unknown Artist",
        "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
        "source": "fallback",
    }


def get_video_meta(video_id: str) -> dict:
    if not is_video_id(video_id):
        raise ValueError("Invalid YouTube video ID")
    if YOUTUBE_API_KEY:
        try:
            url = (
                "https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id="
                + video_id + "&key=" + YOUTUBE_API_KEY
            )
            data = _http_get_json(url)
            items = data.get("items", [])
            if items:
                sn = items[0].get("snippet", {})
                stats = items[0].get("statistics", {})
                thumbs = (sn.get("thumbnails") or {})
                thumb = (thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}).get("url")
                return {
                    "youtube_id": video_id,
                    "title": sn.get("title", ""),
                    "channel": sn.get("channelTitle", ""),
                    "description": sn.get("publishedAt", ""),
                    "thumbnail": thumb or f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                    "view_count": stats.get("viewCount"),
                    "source": "youtube-data-api",
                }
        except Exception:
            pass
    return oembed_meta(video_id)


def search_videos(query: str, max_results: int = 10) -> dict:
    query = (query or "").strip()
    if not query:
        raise ValueError("query is required")
    max_results = max(1, min(25, int(max_results or 10)))
    if YOUTUBE_API_KEY:
        try:
            url = (
                "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults="
                + str(max_results) + "&q=" + urllib.parse.quote(query) + "&key=" + YOUTUBE_API_KEY
            )
            data = _http_get_json(url)
            items = []
            for it in data.get("items", []):
                vid = ((it.get("id") or {}).get("videoId")) or ""
                sn = it.get("snippet", {})
                if is_video_id(vid):
                    items.append({
                        "youtube_id": vid,
                        "title": sn.get("title", ""),
                        "channel": sn.get("channelTitle", ""),
                        "thumbnail": f"https://img.youtube.com/vi/{vid}/hqdefault.jpg",
                    })
            return {"source": "youtube-data-api", "items": items}
        except Exception:
            pass
    return {"source": "disabled", "items": [], "hint": "YOUTUBE_API_KEY が未設定のため検索は無効です。URL/IDでの追加をご利用ください。"}


if __name__ == "__main__":
    import sys
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps(get_video_meta(arg), ensure_ascii=False))
