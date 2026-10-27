"""UMAP/PCA の自然な配置を維持し、マップ全体が小さい場合だけ拡大する。"""


def spread_map_points(coords):
    """個々の点には反発・順位補正・乱数を加えず、全体を一様に拡大。"""
    points = [list(point) for point in coords]
    if len(points) < 3:
        return points
    lo = [min(p[axis] for p in points) for axis in (0, 1)]
    hi = [max(p[axis] for p in points) for axis in (0, 1)]
    span = max(hi[axis] - lo[axis] for axis in (0, 1))
    # 既にマップ全体へ散らばっている場合、局所的な密集はそのまま残す。
    if span >= 0.65 or span <= 1e-12:
        return points
    scale = 0.8 / span
    center = [(lo[axis] + hi[axis]) / 2 for axis in (0, 1)]
    return [[0.5 + (p[axis] - center[axis]) * scale for axis in (0, 1)]
            for p in points]
