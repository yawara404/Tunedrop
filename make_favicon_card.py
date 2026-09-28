#!/usr/bin/env python3
"""frontend/favicon-card.png (512x512) を生成する。

なぜ必要か
----------
SNS (X / LINE / Discord など) や Google の検索結果に出す og:image には
ラスタ画像 (PNG/JPG) が必要で、favicon.svg は OG 画像として扱われない。
そこで「ファビコンと同じ意匠」を 512x512 の PNG にしたものを og:image に使う。
文字入りの横長カード (1200x630) は使わない (Midair.io と同じ方式)。

デザインは frontend/favicon.svg と対になっている (背景色・アクセント色・"T" の位置と大きさ)。
favicon.svg を変えたときは、このスクリプトの数値も合わせて直して再実行し、
Git に PNG の差分として残す。

使い方
------
    .venv/bin/python make_favicon_card.py          # frontend/favicon-card.png を更新
    .venv/bin/python make_favicon_card.py out.png  # 出力先を指定
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Pillow 11以降はプラグインを遅延読み込みする。init() を呼ばないと
# 「unknown file extension: .png」で保存に失敗するため、必ず先に呼ぶ。
Image.init()

ROOT = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'frontend' / 'favicon-card.png'

SIZE = 512
VIEW = 64                     # frontend/favicon.svg の viewBox は 0 0 64 64
SCALE = SIZE / VIEW
BG = '#121212'                # frontend/style.css の --bg-color
ICON_BG = '#111111'           # favicon.svg の角丸四角の色
ACCENT = '#d4e157'            # favicon.svg の "T" の色 (--accent-color)
FONT_SIZE = 36 * SCALE        # favicon.svg の font-size
BASELINE_Y = 44 * SCALE       # favicon.svg の text の y
RECT = [2 * SCALE, 2 * SCALE, (2 + 60) * SCALE, (2 + 60) * SCALE]
RADIUS = 14 * SCALE

FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]


def pick_font(size):
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit('使えるフォントが見つかりません: ' + ', '.join(FONTS))


def main():
    # 透過なし (RGB) にする。透過PNGは SNS 側で背景が白く出ることがある。
    image = Image.new('RGB', (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(image)
    # favicon.svg の角丸四角。拡大すると角の外側が透明になってしまうため、
    # 背景色で塗った上にほぼ同色 (#121212 の上に #111111) の四角を置く。
    draw.rounded_rectangle(RECT, radius=RADIUS, fill=ICON_BG)
    draw.text((SIZE / 2, BASELINE_Y), 'T', font=pick_font(FONT_SIZE), fill=ACCENT, anchor='ms')
    image.save(OUT)
    print(f'生成: {OUT} ({SIZE}x{SIZE}, {OUT.stat().st_size // 1024}KB)')


if __name__ == '__main__':
    main()
