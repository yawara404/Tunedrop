"""局所的な密集は残し、全体が狭い場合だけ相対距離を保って拡大。"""
import math
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from radar_layout import spread_map_points

wide = [[.1,.2],[.101,.201],[.105,.202],[.9,.8]]
assert spread_map_points(wide) == wide  # 近い3点を押し離さない
small = [[.4,.4],[.401,.401],[.43,.42],[.5,.5]]
result = spread_map_points(small)
assert math.isclose(max(p[0] for p in result) - min(p[0] for p in result), .8)
scale = math.dist(result[0], result[1]) / math.dist(small[0], small[1])
for i in range(len(small)):
    for j in range(i):
        assert math.isclose(math.dist(result[i],result[j]), math.dist(small[i],small[j])*scale)
assert small[0] == [.4,.4]
assert spread_map_points(small) == result
assert spread_map_points([[.5,.5]]*10) == [[.5,.5]]*10
assert spread_map_points([]) == []
print('PASS: 自然な間隔・局所的密集を保持、全体のみ拡大、再現性・入力保護')
