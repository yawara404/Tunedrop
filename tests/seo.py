"""SEO checks for the landing page / sitemap / robots.

Google 検索に出るための最低限の技術的SEOが崩れていないことを確認する:
  - title / description に検索語 (YouTube・プレイリスト) が入っている
  - canonical / hreflang / robots (index, follow) がトップURLを指している
  - WebSite / Organization / WebApplication / FAQPage の構造化データが有効なJSON
  - JSのナビ (button + onclick) とは別に、クロールできる <a href> の内部リンクがある
  - sitemap.xml / robots.txt がトップURLとサイトマップを指している
ビルド成果物 (frontend/dist/index.html) も同じ内容か確認する (配信されるのはこちら)。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 正規URLは /tunedrop/ (小文字)。ホスト直下 / と大文字 /Tunedrop/ は 301 で寄せる。
BASE = 'https://music.wawa-app.me/tunedrop/'
FRONTEND = (ROOT / 'frontend' / 'index.html').read_text(encoding='utf-8')
DIST_INDEX = ROOT / 'frontend' / 'dist' / 'index.html'
if not DIST_INDEX.is_file():
    raise SystemExit('先に npm --prefix frontend run build を実行してください。')
DIST = DIST_INDEX.read_text(encoding='utf-8')
SITEMAP = (ROOT / 'sitemap.xml').read_text(encoding='utf-8')
ROBOTS = (ROOT / 'robots.txt').read_text(encoding='utf-8')

for name, html in (('frontend/index.html', FRONTEND), ('frontend/dist/index.html', DIST)):
    title = re.search(r'<title>(.*?)</title>', html, re.S).group(1).strip()
    assert 'Tune drop' in title, (name, title)
    assert 'YouTube' in title and 'プレイリスト' in title, (name, title)
    assert len(title) <= 70, (name, len(title))

    description = re.search(r'<meta name="description"\s+content="(.*?)"', html, re.S).group(1)
    assert 'YouTube' in description and 'プレイリスト' in description, (name, description)
    assert 70 <= len(description) <= 160, (name, len(description))

    assert f'<link rel="canonical" href="{BASE}">' in html, name
    assert f'<link rel="alternate" hreflang="ja" href="{BASE}">' in html, name
    robots = re.search(r'<meta name="robots" content="(.*?)">', html).group(1)
    assert 'index' in robots and 'follow' in robots, (name, robots)
    assert 'noindex' not in robots, (name, robots)
    assert 'max-image-preview:large' in robots, (name, robots)

    assert 'name="google-site-verification"' in html, name
    assert f'<meta property="og:image" content="{BASE}frontend/ogp-card.png' in html, name

    # 構造化データは1つの @graph にまとめている (Google の推奨形式)。
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    assert blocks, name
    data = json.loads(blocks[0])
    types = set()
    for node in data['@graph']:
        node_type = node.get('@type')
        types.update(node_type if isinstance(node_type, list) else [node_type])
    assert {'WebSite', 'WebApplication', 'Organization', 'FAQPage'} <= types, (name, types)
    faq = next(node for node in data['@graph'] if node.get('@type') == 'FAQPage')
    assert len(faq['mainEntity']) >= 4, name

    # nav は <button onclick> なので、検索エンジンがたどれる <a href> を必ず持つ。
    assert f'<a class="welcome-help-link" href="./help">' in html, name
    assert 'href="./share"' in html and 'href="./radar"' in html, name
    assert 'href="https://github.com/yawara404/Tunedrop"' in html, name
    # js 無効時にも概要が読める
    noscript = re.search(r'<noscript>(.*?)</noscript>', html, re.S).group(1)
    assert 'YouTube' in noscript and 'プレイリスト' in noscript, name

assert re.search(r'<loc>' + re.escape(BASE) + r'</loc>', SITEMAP)
assert re.search(r'<lastmod>\d{4}-\d{2}-\d{2}</lastmod>', SITEMAP)
assert '<priority>1.0</priority>' in SITEMAP
# noindex のページ (ogp.php) はサイトマップに載せない
assert all('ogp.php' not in loc for loc in re.findall(r'<loc>([^<]+)</loc>', SITEMAP))

assert f'Sitemap: {BASE}sitemap.xml' in ROBOTS
assert 'Disallow: /tunedrop/api.php' in ROBOTS
assert 'Allow: /' in ROBOTS
# 正規URL (/tunedrop/) を誤ってブロックしていないこと
assert not re.search(r'^Disallow: /tunedrop/?$', ROBOTS, re.M)
assert not re.search(r'^Disallow: /$', ROBOTS, re.M)

# 共有カード (ogp.php) はカード表示専用で、意図的に noindex のままにする。
OGP = (ROOT / 'backend' / 'ogp.php').read_text(encoding='utf-8')
assert '<meta name="robots" content="noindex, nofollow">' in OGP

print('PASS: SEO metadata, structured data, sitemap/robots and crawlable links are configured.')
