#!/usr/bin/env python3
"""UMAP 2次元埋め込みによる楽曲マップ座標の算出。

vibe_analyzer が抽出した固定長の音響特徴ベクトルを UMAP で
2次元へ射影し、[0,1] へ正規化してフロントのマップ描画に使える座標にする。
UMAP 未導入や次元不足・少数サンプル時は PCA / 円配置へフォールバックする。
"""
import numpy as np


def _normalize(emb):
    arr = np.asarray(emb, dtype="float64")
    if arr.ndim != 2 or arr.shape[0] == 0:
        return []
    mn = arr.min(axis=0)
    mx = arr.max(axis=0)
    rng = mx - mn
    rng[rng == 0] = 1.0
    norm = (arr - mn) / rng
    norm = norm * 0.9 + 0.05   # 5% 余白を付ける
    return np.clip(norm, 0.0, 1.0).tolist()


def _pca2d(X):
    X = X - X.mean(axis=0)
    try:
        _, _, vt = np.linalg.svd(X, full_matrices=False)
        return X @ vt[:2].T
    except Exception:
        return X[:, :2]


def embed(features, n_neighbors=15, min_dist=0.1, random_state=42):
    """(coords, method) を返す。coords は各曲の [x, y] ([0,1])。"""
    feats = []
    for f in features:
        f = list(f or [])
        if f:
            feats.append(f)
    n = len(feats)
    if n == 0:
        return [], "none"
    if n == 1:
        return [[0.5, 0.5]], "none"
    if n == 2:
        return [[0.0, 0.0], [1.0, 1.0]], "none"

    X = np.asarray(feats, dtype="float64")
    std = X.std(axis=0)
    keep = std > 1e-12
    if not keep.any():
        # 全次元が定数 → 均等円配置にフォールバック
        ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
        return np.column_stack([0.5 + 0.4 * np.cos(ang),
                                0.5 + 0.4 * np.sin(ang)]).tolist(), "circle"

    X = X[:, keep]
    std = X.std(axis=0)
    std[std == 0] = 1.0
    Z = (X - X.mean(axis=0)) / std

    nn = max(2, min(n_neighbors, n - 1))
    method = "umap"
    try:
        import umap  # noqa: F401
        reducer = umap.UMAP(
            n_components=2, n_neighbors=nn, min_dist=min_dist,
            metric="euclidean", random_state=random_state, n_epochs=200,
        )
        emb = reducer.fit_transform(Z)
        if np.asarray(emb).shape[0] != n:
            raise RuntimeError("bad embedding shape")
    except Exception:
        method = "pca"
        emb = _pca2d(Z)

    coords = _normalize(emb)
    if len(coords) != n:   # 最終保険
        coords = [[0.5, 0.5] for _ in range(n)]
        method = "none"
    return coords, method


if __name__ == "__main__":
    import json
    demo = [
        [0.1, 0.2, 0.3, 1.0, 0.5],
        [0.9, 0.8, 0.7, 0.0, 0.5],
        [0.2, 0.1, 0.4, 0.8, 0.6],
        [0.8, 0.9, 0.6, 0.2, 0.4],
    ]
    print(json.dumps(embed(demo), ensure_ascii=False))
