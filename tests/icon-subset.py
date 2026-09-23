"""Material Symbols のサブセット (icon_names) が実際に使うアイコンを網羅しているか確認する。

index.html は全アイコン収録版 (約3.1MB) を避けるため icon_names でアイコンを絞っている。
未知の名前が1つでも混ざると全収録版へフォールバックしてしまうため、
静的マークアップ (index.html / frontend/app.js) に書かれたアイコン名が
icon_names に含まれていることを検証する。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
index = (ROOT / 'index.html').read_text(encoding='utf-8')

match = re.search(r'icon_names=([^&"]+)', index)
assert match, 'index.html に Material Symbols の icon_names がありません'
subset = set(match.group(1).split(','))
assert subset, 'icon_names が空です'

used = set()
for name in ('index.html', 'frontend/app.js'):
    text = (ROOT / name).read_text(encoding='utf-8')
    # 静的な <span class="material-symbols-rounded">name</span>
    used |= set(re.findall(r'material-symbols-rounded[^>]*>\s*([a-z_]+)\s*<', text))
    # 三項演算子などで切り替える動的な名前 (例: ${isFav ? 'heart_broken' : 'favorite'})
    for span in re.findall(r'material-symbols-rounded[^>]*>(.{0,240}?)</span>', text, re.S):
        used |= set(re.findall(r"'([a-z_]{3,})'", span))

missing = sorted(used - subset)
assert not missing, f'icon_names に無いアイコンを使っています (全収録版にフォールバックします): {missing}'

# 使っていないアイコンはサブセットから外しておく (サイズ削減)
unused = sorted(subset - used)
assert not unused, f'icon_names に未使用のアイコンがあります: {unused}'

print(f'PASS: Material Symbols の {len(subset)} アイコンは実際の使用と一致している。')
