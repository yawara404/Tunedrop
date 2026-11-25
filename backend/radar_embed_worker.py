"""One bounded UMAP calculation; native failures cannot terminate the web server."""
import json
import sys


def main():
    import numpy as np
    import umap

    data = json.load(sys.stdin)
    reducer = umap.UMAP(
        n_components=2, n_neighbors=data['n_neighbors'], min_dist=data['min_dist'],
        metric='euclidean', random_state=data['random_state'], n_epochs=200, n_jobs=1,
    )
    coords = reducer.fit_transform(np.asarray(data['vectors'], dtype='float64'))
    json.dump(coords.tolist(), sys.stdout, allow_nan=False)


if __name__ == '__main__':
    main()
