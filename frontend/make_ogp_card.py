#!/usr/bin/env python3
"""ogp-card.png (1200x630) を生成する。

未ログインのウェルカム画面 (サイトの使い方ガイド + Radarデモ) と同じ構図:
  - 左: タグライン「音楽で触れ合うブックマーク」+ 見出し + 3ステップの使い方 (Manager / Radar / Share)
  - 右: URL保存 → 2D雰囲気マップ (Radar) → 公開共有・5曲デモのビジュアルプレビュー
  - 背景はアプリと同じダーク。黄色は使わない。

使い方:
    .venv/bin/python frontend/make_ogp_card.py
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

Image.init()

FRONTEND_DIR = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else FRONTEND_DIR / 'ogp-card.png'

W, H = 1200, 630
BG = '#101210'
PANEL = '#171916'
SURFACE = '#1c1f1a'
LINE = '#2f332d'
TEXT = '#f0f3ed'
SUB = '#9aa398'
MUTED = '#737c72'
MINT = '#7fd8c4'
BLUE = '#8ec5ff'
CORAL = '#ff9a6b'

JP_BOLD = [
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    '/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]
JP_REGULAR = [
    '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
    '/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]
LATIN_BOLD = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]
LATIN_REGULAR = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]


def pick_font(candidates, size):
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit('使えるフォントが見つかりません: ' + ', '.join(candidates))


def text_w(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0]


def draw_spaced(draw, xy, text, font, fill, spacing=2):
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += text_w(draw, char, font) + spacing
    return x


def rounded(draw, box, radius, **kwargs):
    draw.rounded_rectangle(box, radius=radius, **kwargs)


def mix(color_a, color_b, amount):
    a = tuple(int(color_a[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(color_b[i:i + 2], 16) for i in (1, 3, 5))
    return tuple(round(a[i] + (b[i] - a[i]) * amount) for i in range(3))


def main():
    image = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(image)

    # 背景のドットグリッドと淡い光
    grid = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(24, W, 26):
        for y in range(24, H, 26):
            gd.rectangle([x, y, x + 1, y + 1], fill=(255, 255, 255, 9))
    image = Image.alpha_composite(image.convert('RGBA'), grid).convert('RGB')

    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([720, -240, 1440, 460], fill=(142, 197, 255, 18))
    gd.ellipse([-260, 260, 480, 980], fill=(127, 216, 196, 12))
    image = Image.alpha_composite(image.convert('RGBA'), glow).convert('RGB')
    draw = ImageDraw.Draw(image)

    font_brand = pick_font(LATIN_BOLD, 21)
    font_brand_sub = pick_font(LATIN_BOLD, 10)
    font_label = pick_font(LATIN_BOLD, 10)
    font_title = pick_font(JP_BOLD, 44)
    font_sub = pick_font(JP_REGULAR, 16)
    font_step_title = pick_font(JP_BOLD, 15)
    font_step_sub = pick_font(JP_REGULAR, 12)
    font_small = pick_font(JP_REGULAR, 12)
    font_small_bold = pick_font(JP_BOLD, 12)
    font_jp_tiny = pick_font(JP_BOLD, 10)
    font_tiny = pick_font(LATIN_BOLD, 9)
    font_url = pick_font(LATIN_REGULAR, 14)
    font_chip = pick_font(LATIN_BOLD, 10)
    font_num = pick_font(LATIN_BOLD, 11)

    # ---- ブランド ----
    rounded(draw, [60, 42, 98, 80], 10, fill=SURFACE, outline='#4b5148', width=1)
    draw.ellipse([74, 56, 84, 66], fill=MINT)
    draw.text((112, 48), 'TUNE DROP', font=font_brand, fill=TEXT)
    draw_spaced(draw, (112, 71), 'MUSIC BOOKMARK / MANAGER · RADAR · SHARE', font_brand_sub, SUB, spacing=1)

    # ---- タグラインバッジ + 見出し ----
    rounded(draw, [60, 96, 294, 122], 13, fill='#161916', outline='#343a32', width=1)
    draw.ellipse([73, 105, 81, 113], fill=MINT)
    draw.text((90, 102), '音楽で触れ合うブックマーク', font=font_small_bold, fill='#d9e6d8')

    draw.text((60, 134), '好きな曲を残して、', font=font_title, fill=TEXT)
    draw.text((60, 188), '音楽と人に出会う。', font=font_title, fill=TEXT)

    # アクセントライン (Blue / Mint / Coral)
    draw.rounded_rectangle([62, 246, 152, 251], radius=2, fill=BLUE)
    draw.rounded_rectangle([158, 246, 248, 251], radius=2, fill=MINT)
    draw.rounded_rectangle([254, 246, 344, 251], radius=2, fill=CORAL)

    draw.text((60, 264), 'YouTubeのURLで保存・整理。雰囲気マップと公開リストで新しい曲を発掘。',
              font=font_sub, fill=SUB)

    # ---- 左下: 3ステップでわかるサイトの使い方 ----
    draw_spaced(draw, (60, 300), 'HOW TO USE / 3つの画面と使い方', font_small_bold, '#b7c1b5', spacing=0)

    steps = [
        (
            '01',
            'MANAGER · 集める',
            'YouTubeのURLを貼って保存・リストに整理',
            '曲名・サムネイルを自動取得。気分やシーン別の棚にまとめて連続再生',
            BLUE,
        ),
        (
            '02',
            'RADAR · 見つける',
            '2D雰囲気マップで似た曲を発掘・その場で保存',
            'AI×音源解析でBPM・エネルギーを地図に配置。周辺曲をまとめて試聴',
            MINT,
        ),
        (
            '03',
            'SHARE · つながる',
            '公開プレイリストを共有・誰かの選曲を自分の棚へ',
            '気に入った1曲だけを自分のリストへ追加。お気に入り＆フォローで交流',
            CORAL,
        ),
    ]

    for idx, (num, badge, title, desc, color) in enumerate(steps):
        top = 326 + idx * 82
        bottom = top + 72
        rounded(draw, [60, top, 646, bottom], 14, fill=PANEL, outline=LINE, width=1)
        # 左のカラーバー
        draw.rounded_rectangle([60, top + 12, 65, bottom - 12], radius=2, fill=color)
        # 番号バッジ
        rounded(draw, [78, top + 13, 112, top + 33], 7, fill='#121412', outline=color, width=1)
        draw.text((95, top + 23), num, font=font_chip, fill=color, anchor='mm')
        # 画面名チップ
        badge_w = text_w(draw, badge, font_small_bold) + 18
        rounded(draw, [120, top + 13, 120 + badge_w, top + 33], 10, fill='#121412', outline='#363c34', width=1)
        draw.text((129, top + 17), badge, font=font_small_bold, fill=color)
        # ステップ見出し
        draw.text((128 + badge_w, top + 15), title, font=font_step_title, fill=TEXT)
        # 補足説明
        draw.text((78, top + 44), desc, font=font_step_sub, fill=SUB)

    # ---- 右: サイト体験プレビューパネル ----
    rounded(draw, [676, 42, 1140, 566], 20, fill=PANEL, outline=LINE, width=1)
    draw.text((704, 62), 'SITE PREVIEW', font=font_label, fill=SUB)
    draw.text((704, 78), 'URL保存 → 雰囲気マップ → 公開リスト共有', font=font_small_bold, fill='#d0d8ce')
    rounded(draw, [1016, 62, 1116, 86], 12, fill='#121512', outline=MINT, width=1)
    draw.text((1066, 74), 'FREE WEB APP', font=font_tiny, fill=MINT, anchor='mm')

    # 右1: Manager (URL貼付 → 曲カード)
    mgr_box = [700, 106, 1116, 208]
    rounded(draw, mgr_box, 12, fill='#111311', outline='#2c302a', width=1)
    draw.text((716, 116), '01 · MANAGER — URLを貼って曲を保存', font=font_small_bold, fill=BLUE)
    # URLバー
    rounded(draw, [716, 138, 1024, 164], 7, fill='#0b0d0b', outline='#2d322b', width=1)
    draw.text((726, 145), 'https://youtu.be/uSijY6BEMRE', font=font_chip, fill=MUTED)
    rounded(draw, [1032, 138, 1100, 164], 7, fill=BLUE)
    draw.text((1066, 151), '+ 追加', font=font_small_bold, fill='#0d1217', anchor='mm')
    # 保存された曲行
    draw.ellipse([718, 178, 728, 188], fill=BLUE)
    draw.text((736, 175), 'Yellow / livetune', font=font_small_bold, fill=TEXT)
    rounded(draw, [886, 174, 968, 194], 9, fill=None, outline=BLUE, width=1)
    draw.text((927, 184), '夜のドライブ', font=font_jp_tiny, fill=BLUE, anchor='mm')
    rounded(draw, [974, 174, 1038, 194], 9, fill=None, outline='#3a4038', width=1)
    draw.text((1006, 184), '127 BPM', font=font_tiny, fill=SUB, anchor='mm')

    # 右2: Radar (2D雰囲気マップ)
    map_box = [700, 220, 1116, 474]
    rounded(draw, map_box, 12, fill='#0d0f0d', outline='#2d312b', width=1)
    draw.text((716, 232), '02 · RADAR — 2D雰囲気マップで似た曲を発掘', font=font_small_bold, fill=MINT)

    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    cx, cy = (map_box[0] + map_box[2]) / 2, (map_box[1] + 28 + map_box[3]) / 2
    od.line([map_box[0] + 14, cy, map_box[2] - 14, cy], fill=(255, 255, 255, 20), width=1)
    od.line([cx, map_box[1] + 38, cx, map_box[3] - 14], fill=(255, 255, 255, 20), width=1)
    for radius in (36, 70, 102):
        od.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                   outline=(255, 255, 255, 24), width=1)
    image = Image.alpha_composite(image.convert('RGBA'), overlay).convert('RGB')
    draw = ImageDraw.Draw(image)

    # 背景の点 (公開Radarの曲群)
    for i in range(20):
        angle = i * 2.399
        radius = 20 + (i * 15) % 90
        x = cx + math.cos(angle) * radius * 1.25
        y = cy + math.sin(angle) * radius * 0.72
        if map_box[0] + 18 < x < map_box[2] - 18 and map_box[1] + 44 < y < map_box[3] - 18:
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=mix(BG, '#ffffff', 0.25))

    # 5曲のノード
    picks = [
        (0.68, 0.42, MINT, '1'),
        (0.45, 0.55, BLUE, '2'),
        (0.61, 0.74, CORAL, '3'),
        (0.28, 0.66, BLUE, '4'),
        (0.81, 0.30, CORAL, '5'),
    ]
    points = []
    for nx, ny, color, label in picks:
        x = map_box[0] + 24 + nx * (map_box[2] - map_box[0] - 48)
        y = map_box[1] + 42 + ny * (map_box[3] - map_box[1] - 60)
        points.append((x, y, color, label))

    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            draw.line([points[i][0], points[i][1], points[j][0], points[j][1]],
                      fill=(255, 255, 255, 16), width=1)
    for x, y, color, label in points:
        draw.ellipse([x - 15, y - 15, x + 15, y + 15], fill=mix(color, BG, 0.76))
        draw.ellipse([x - 12, y - 12, x + 12, y + 12], fill=color)
        draw.text((x, y), label, font=font_num, fill='#101410', anchor='mm')

    draw.text((716, 450), 'ENERGY / TEMPO / MOOD', font=font_tiny, fill=MUTED)
    rounded(draw, [946, 442, 1102, 464], 10, fill='#151915', outline='#343b33', width=1)
    draw.text((1024, 453), '周辺曲を連続再生・保存', font=font_step_sub, fill='#c9d3c7', anchor='mm')

    # 右3: Share & ログインなし5曲デモ
    share_box = [700, 486, 1116, 550]
    rounded(draw, share_box, 12, fill='#111311', outline='#2c302a', width=1)
    draw.text((716, 497), '03 · SHARE & DEMO — 公開リスト共有・ログインなしで試聴', font=font_small_bold, fill=CORAL)
    draw.text((716, 521), 'みんなの公開リストを探索 · トップ画面でランダム5曲デモを再生可能', font=font_step_sub, fill=SUB)

    # ---- フッター ----
    draw.text((60, 592), 'music.wawa-app.me/tunedrop', font=font_url, fill='#7d867b')
    draw.text((878, 594), 'COLLECT · DISCOVER · SHARE WITH MUSIC', font=font_tiny, fill='#6f786e')

    image.save(OUT, optimize=True)
    print(f'生成: {OUT} ({W}x{H}, {OUT.stat().st_size // 1024}KB)')


if __name__ == '__main__':
    main()
