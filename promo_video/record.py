"""Tune drop 本番サイトの実画面を録画して SNS 用の縦型動画 (1080x1920) を作る。

使い方: .venv/bin/python promo_video/record.py            (縦型 1080x1920)
        .venv/bin/python promo_video/record.py landscape  (横型 1920x1080)
出力  : promo_video/raw/*.webm -> promo_video/tunedrop_radar_promo[_landscape].mp4
"""
import glob
import os
import shutil
import subprocess
import sys

from playwright.sync_api import sync_playwright

URL = "https://music.wawa-app.me/tunedrop/"
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
# 引数 landscape で横型 (PC表示 1920x1080)。省略時は縦型 (スマホ表示 1080x1920)
LANDSCAPE = len(sys.argv) > 1 and sys.argv[1] == "landscape"
OUT = os.path.join(HERE, "tunedrop_radar_promo_landscape.mp4" if LANDSCAPE else "tunedrop_radar_promo.mp4")
VIEW = {"width": 1280, "height": 720} if LANDSCAPE else {"width": 432, "height": 768}
VIDEO = {"width": 1920, "height": 1080} if LANDSCAPE else {"width": 1080, "height": 1920}
DSF = 1.5 if LANDSCAPE else 2.5
MOBILE = not LANDSCAPE
LANDSCAPE_CSS = """
  #pr-cap { font-size:28px; bottom:70px; max-width:60%; padding:14px 28px; }
  #pr-card .l { font-size:96px; } #pr-card .t { font-size:42px; } #pr-card .s { font-size:22px; }
  #pr-card .u { font-size:26px; padding:14px 30px; }
  .pr-ripple { width:60px; height:60px; }
"""

OVERLAY_JS = r"""
(() => {
  if (window.__promo) return;
  const css = document.createElement('style');
  css.textContent = `
  @keyframes pr-ripple { from { transform: translate(-50%,-50%) scale(.3); opacity:.9 } to { transform: translate(-50%,-50%) scale(2.2); opacity:0 } }
  .pr-ripple { position:fixed; z-index:99999; width:46px; height:46px; border-radius:50%;
    border:3px solid #d6f03a; background:rgba(214,240,58,.25); pointer-events:none;
    animation: pr-ripple .7s ease-out forwards; }
  #pr-cap { position:fixed; left:50%; bottom:118px; transform:translate(-50%,12px); z-index:99998;
    max-width:88%; padding:10px 18px; border-radius:16px; text-align:center; pointer-events:none;
    font:800 19px/1.35 "Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif; color:#fff;
    background:rgba(18,18,18,.82); border:1.5px solid rgba(214,240,58,.85);
    box-shadow:0 8px 28px rgba(0,0,0,.55); opacity:0; transition:opacity .35s, transform .35s; letter-spacing:.02em; }
  #pr-cap.on { opacity:1; transform:translate(-50%,0); }
  #pr-cap em { font-style:normal; color:#d6f03a; }
  #pr-card { position:fixed; inset:0; z-index:100000; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:14px; text-align:center; color:#fff; opacity:0; pointer-events:none; transition:opacity .6s;
    background:radial-gradient(circle at 50% 35%, #2a2f12 0%, #121212 65%);
    font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif; }
  #pr-card.on { opacity:1; }
  #pr-card .l { font:800 54px/1 Inter,"Hiragino Sans",sans-serif; color:#d6f03a; letter-spacing:.01em; }
  #pr-card .t { font-weight:800; font-size:25px; line-height:1.45; }
  #pr-card .s { font-size:15px; color:#bbb; line-height:1.6; }
  #pr-card .u { margin-top:10px; padding:10px 20px; border-radius:99px; background:#d6f03a; color:#121212;
    font:800 17px Inter,sans-serif; }
  `;
  css.textContent += window.__promoExtraCss || '';
  document.head.appendChild(css);
  const cap = document.createElement('div'); cap.id = 'pr-cap'; document.body.appendChild(cap);
  const card = document.createElement('div'); card.id = 'pr-card'; document.body.appendChild(card);
  window.__promo = {
    cap(html) { if (!html) { cap.classList.remove('on'); return; } cap.innerHTML = html; cap.classList.add('on'); },
    card(html) { if (!html) { card.classList.remove('on'); return; } card.innerHTML = html; card.classList.add('on'); },
    ripple(x, y) { const r = document.createElement('div'); r.className = 'pr-ripple';
      r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 800); },
  };
})();
"""


def scout_dots(browser):
    """録画しない別コンテキストで、タップすると選択パネルが開く点の座標を探す。"""
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=1, is_mobile=MOBILE, has_touch=MOBILE, locale="ja-JP")
    pg = ctx.new_page()
    pg.goto(URL, wait_until="networkidle")
    pg.evaluate("navigateView('radar')")
    pg.wait_for_timeout(5000)
    box = pg.locator("#radar-map-canvas").bounding_box()
    found = []
    for fy in [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7]:
        for fx in [0.55, 0.45, 0.62, 0.38, 0.7, 0.3, 0.5, 0.6]:
            x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
            (pg.touchscreen.tap if MOBILE else pg.mouse.click)(x, y)
            pg.wait_for_timeout(250)
            if pg.locator("#radar-selected-panel").is_visible():
                found.append((x, y))
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(200)
                if pg.locator("#radar-selected-panel").is_visible():
                    pg.evaluate("document.querySelector('.radar-panel-close')?.click()")
                if len(found) >= 3:
                    ctx.close()
                    return found, box
    ctx.close()
    return found, box


def run():
    shutil.rmtree(RAW, ignore_errors=True)
    os.makedirs(RAW)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        dots, box = scout_dots(browser)
        print("dots", dots)
        if not dots:
            raise SystemExit("タップできる点が見つかりませんでした")

        ctx = browser.new_context(viewport=VIEW, device_scale_factor=DSF, is_mobile=MOBILE, has_touch=MOBILE,
                                  locale="ja-JP", record_video_dir=RAW, record_video_size=VIDEO)
        pg = ctx.new_page()
        pg.goto(URL, wait_until="networkidle")
        pg.evaluate("navigateView('radar')")
        pg.wait_for_timeout(500)
        pg.evaluate("c => window.__promoExtraCss = c", LANDSCAPE_CSS if LANDSCAPE else "")
        pg.evaluate(OVERLAY_JS)

        def tap(x, y, wait=900):
            pg.evaluate("([x,y]) => window.__promo.ripple(x,y)", [x, y])
            pg.wait_for_timeout(250)
            (pg.touchscreen.tap if MOBILE else pg.mouse.click)(x, y)
            pg.wait_for_timeout(wait)

        def tap_el(sel, wait=900):
            b = pg.locator(sel).locator("visible=true").first.bounding_box()
            tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2, wait)

        def cap(html, ms):
            pg.evaluate("h => window.__promo.cap(h)", html)
            pg.wait_for_timeout(ms)

        # 1) イントロカード
        pg.evaluate("""window.__promo.card(`<div class="l">Tune drop</div>
          <div class="t">好きな曲の<em style="font-style:normal;color:#d6f03a">「雰囲気」</em>で<br>音楽を発掘する</div>
          <div class="s">YouTubeの音楽をコレクション&amp;<br>AI×音源解析のRadarマップ</div>`)""")
        pg.wait_for_timeout(3600)
        pg.evaluate("window.__promo.card(null)")
        pg.wait_for_timeout(900)

        # 2) マップ全体
        cap("372曲が<em>「雰囲気」</em>で<br>1枚のマップに並ぶ", 3600)
        cap("← dark　　bright →<br>上は<em>energy</em>、下は<em>calm</em>", 3400)
        cap(None, 300)

        # 3) 点をタップ → 選択カード
        cap("点をタップして<em>曲を選択</em>", 600)
        tap(*dots[0], wait=1800)
        cap("ジャンル・BPM・雰囲気タグも<br>ひと目でわかる", 3200)

        # 4) 周辺曲
        cap("<em>「周辺N曲」</em>で近い雰囲気の曲を<br>まとめて連続再生", 800)
        tap_el(".radar-panel-btn:nth-child(2)", wait=3800)
        cap("下の一覧も<em>その曲たちだけ</em>に絞り込み", 3000)
        strip = pg.locator("#vibe-track-strip")
        if strip.count():
            for _ in range(4):
                pg.evaluate("document.getElementById('vibe-track-strip').scrollBy({left:170,behavior:'smooth'})")
                pg.wait_for_timeout(650)
        cap(None, 300)

        # 5) 条件クリア→絞り込み
        pg.evaluate("clearRadarFilters && clearRadarFilters()")
        pg.wait_for_timeout(1200)
        cap("<em>雰囲気・BPM・ジャンル</em>で<br>好みの曲だけを表示", 900)
        if pg.locator("#btn-radar-filters-toggle").is_visible():
            tap_el("#btn-radar-filters-toggle", wait=1600)
        opts = pg.eval_on_selector_all("#radar-vibe-filter option", "o => o.map(x => x.value)")
        vals = [v for v in opts if v]
        if vals:
            pick = vals[min(2, len(vals) - 1)]
            pg.select_option("#radar-vibe-filter", pick)
            pg.wait_for_timeout(1800)
        tempos = [v for v in pg.eval_on_selector_all("#radar-tempo-filter option", "o => o.map(x => x.value)") if v]
        if tempos:
            pg.select_option("#radar-tempo-filter", tempos[min(1, len(tempos) - 1)])
            pg.wait_for_timeout(1800)
        if pg.locator(".radar-filters-done").is_visible():
            tap_el(".radar-filters-done", wait=1800)
        cap("条件に合う曲だけが<br>マップに残る", 2800)
        pg.evaluate("clearRadarFilters && clearRadarFilters()")
        pg.wait_for_timeout(1200)

        # 6) ランダム発掘
        cap("迷ったら<em>📡 Radar</em>をタップ<br>ランダムに3曲を発掘", 900)
        tap_el("#btn-radar-random", wait=4200)

        # 7) ズーム
        cap("ズーム・ドラッグで<br>気になるエリアを探索", 800)
        zin = ".radar-map-zoom button:nth-child(1), #btn-radar-zoom-in"
        zfit = ".radar-map-zoom button:nth-child(3), #btn-radar-zoom-fit"
        tap_el(zin, wait=900)
        tap_el(zin, wait=900)
        tap_el(zfit, wait=1800)
        cap(None, 300)

        # 8) アウトロ
        pg.evaluate("""window.__promo.card(`<div class="l">Tune drop</div>
          <div class="t">曲を集めて、整理して、<br>みんなと発掘しよう</div>
          <div class="s">無料で使えるWebアプリ<br>スマホ・PCどちらでもOK</div>
          <div class="u">music.wawa-app.me/tunedrop</div>`)""")
        pg.wait_for_timeout(4800)

        ctx.close()   # ここで動画が書き出される
        browser.close()

    webm = sorted(glob.glob(os.path.join(RAW, "*.webm")))[-1]
    subprocess.run([
        "ffmpeg", "-y", "-i", webm, "-vf", f"scale={VIDEO['width']}:{VIDEO['height']}:flags=lanczos,fps=30",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-an", OUT,
    ], check=True)
    print("done", OUT)


if __name__ == "__main__":
    run()
