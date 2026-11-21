"""seb.now as an installable app: manifest, icons, service worker and head tags."""

import json
import math
import re
from pathlib import Path

from PIL import Image

from seb_now.connect import render_connect
from seb_now.consent import render_consent
from seb_now.constants import ICON_SIZE_LARGE, ICON_SIZE_SMALL, MASKABLE_SCALE, SUPABASE_JS_URL
from seb_now.posts import Post, render_post
from seb_now.pwa import (
    INDEX_TEMPLATE_PATH,
    BlockGeometry,
    IconKind,
    Palette,
    app_route_prefixes,
    current_palette,
    favicon_svg,
    manifest,
    precached_paths,
    service_worker,
    write_pwa,
)
from seb_now.site import render
from seb_now.theme import style_tokens

DB_PALETTE = (
    ":root { --color-page: #ebedf1; --color-page-dark: #0b0d14; --color-accent: #75352e; "
    "--color-accent-dark: #c1846e; --block-ink: #333d84; --block-ink-dark: #8b90cf; }"
)
# The launcher may crop a maskable icon to the circle of this radius (as a
# fraction of its edge) around its centre.
MASKABLE_SAFE_RADIUS = 0.4


def _built(tmp_path: Path) -> tuple[str, dict[str, Path]]:
    with style_tokens(DB_PALETTE):
        html = render([], supabase_url="https://example.supabase.co")
        written = write_pwa(tmp_path, html)
    return html, {path.name: path for path in written}


def test_the_palette_comes_from_the_built_in_styles_over_the_theme() -> None:
    assert current_palette().page != "#ebedf1"  # the theme's own default
    with style_tokens(DB_PALETTE):
        assert current_palette() == Palette("#ebedf1", "#0b0d14", "#75352e", "#c1846e", "#333d84", "#8b90cf")


def test_the_manifest_is_installable_and_coloured_by_the_palette(tmp_path: Path) -> None:
    _, files = _built(tmp_path)
    data = json.loads(files["manifest.json"].read_text())
    assert (data["start_url"], data["scope"], data["display"]) == ("/", "/", "standalone")
    assert data["theme_color"] == data["background_color"] == "#ebedf1"
    sizes = {(icon["sizes"], icon["purpose"]) for icon in data["icons"]}
    assert {(f"{ICON_SIZE_SMALL}x{ICON_SIZE_SMALL}", "any"), (f"{ICON_SIZE_LARGE}x{ICON_SIZE_LARGE}", "any")} <= sizes
    assert (f"{ICON_SIZE_LARGE}x{ICON_SIZE_LARGE}", "maskable") in sizes
    for icon in data["icons"]:
        assert (tmp_path / icon["src"].lstrip("/")).is_file()
    for shortcut in data["shortcuts"]:
        assert re.match(r"^/o/\w+$", shortcut["url"])


def test_each_png_icon_has_its_declared_size(tmp_path: Path) -> None:
    _, files = _built(tmp_path)
    for icon in manifest(current_palette())["icons"]:  # type: ignore[attr-defined]
        if icon["type"] == "image/png":
            width, height = icon["sizes"].split("x")
            assert Image.open(files[icon["src"].lstrip("/")]).size == (int(width), int(height))
    assert Image.open(files["apple-touch-icon.png"]).mode == "RGB"  # opaque


def test_the_maskable_block_stays_inside_the_safe_zone() -> None:
    geometry = BlockGeometry.scaled(MASKABLE_SCALE)
    assert IconKind.MASKABLE.scale == MASKABLE_SCALE
    for x, y in geometry.slab:
        assert math.dist((x, y), (0.5, 0.5)) <= MASKABLE_SAFE_RADIUS


def test_the_maskable_icon_is_drawn_in_the_palettes_colours(tmp_path: Path) -> None:
    _, files = _built(tmp_path)
    image = Image.open(files["icon-maskable-512.png"]).convert("RGB")
    assert image.getpixel((2, 2)) == (0xEB, 0xED, 0xF1)  # full-bleed page colour
    assert image.getpixel((ICON_SIZE_LARGE // 2 - 30, ICON_SIZE_LARGE // 2 - 30)) == (0x75, 0x35, 0x2E)  # the dot


def test_the_favicon_follows_the_colour_scheme() -> None:
    with style_tokens(DB_PALETTE):
        svg = favicon_svg(current_palette())
    assert svg.startswith("<svg") and "prefers-color-scheme: dark" in svg
    assert "#0b0d14" in svg and "#8b90cf" in svg


def test_the_service_worker_knows_every_route_the_page_opens_in_place() -> None:
    template = INDEX_TEMPLATE_PATH.read_text()
    patterns = re.findall(r"const (\w+)_PATH_PATTERN = ", template)
    prefixes = app_route_prefixes(template)
    assert len(prefixes) == len(patterns) >= 7
    assert {"/p/", "/e/", "/t/", "/k/", "/i/", "/s/", "/o/"} <= set(prefixes)


def test_the_service_worker_is_filled_and_versioned_by_the_page() -> None:
    template = INDEX_TEMPLATE_PATH.read_text()
    first, second = service_worker("<html>a</html>", template), service_worker("<html>b</html>", template)
    assert "__SW_" not in first
    assert first != second
    assert SUPABASE_JS_URL in first
    for path in precached_paths():
        assert json.dumps(path) in first
    # Pages that aren't the app's own routes are never served from its cache.
    for route in ("/posts/", "/oauth/", "/connect", "/mcp", "/ap/", "/.well-known/"):
        assert json.dumps(route) not in first


def test_the_index_is_installable_and_lets_its_worker_and_manifest_load(tmp_path: Path) -> None:
    html, _ = _built(tmp_path)
    csp = re.search(r'Content-Security-Policy" content="([^"]*)"', html)
    assert csp is not None
    assert "worker-src &#x27;self&#x27;" in csp.group(1)
    assert "manifest-src &#x27;self&#x27;" in csp.group(1)
    assert '<link rel="manifest" href="/manifest.json">' in html
    assert 'name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0d14"' in html
    assert 'const SERVICE_WORKER_URL = "/sw.js";' in html
    assert "<!--__" not in html


def test_other_pages_get_icons_but_no_worker_or_manifest() -> None:
    post = Post(slug="hello", title="Hello", date="2026-11-21", description="", image=None, body_html="<p>hi</p>")
    for page in (render_consent(), render_connect(), render_post(post)):
        assert '<link rel="icon" href="/favicon.svg"' in page
        assert "manifest" not in page
        assert "worker-src" not in page
        assert "<!--__ICON_LINKS__-->" not in page


def test_the_installed_app_draws_edge_to_edge_clear_of_the_system_bars() -> None:
    # Without viewport-fit=cover the standalone app leaves a blank strip under
    # the page where the system's navigation bar sits.
    template = INDEX_TEMPLATE_PATH.read_text()
    assert 'content="width=device-width, initial-scale=1, viewport-fit=cover"' in template
    # Everything fixed to an edge keeps clear of the bars by the safe-area insets.
    assert "--safe-top: env(safe-area-inset-top" in template
    assert "--safe-bottom: env(safe-area-inset-bottom" in template
    # In landscape the cutout sits at a side, so the side gutters keep clear of it too.
    assert "--safe-left: env(safe-area-inset-left" in template
    assert "--safe-right: env(safe-area-inset-right" in template
    for name in ("body", r"\.header-inner", "#search-dock"):
        rule = re.search(r"\n    " + name + r" \{(.*?)\n    \}", template, re.S)
        assert rule is not None, name
        assert "var(--safe-left)" in rule[1] and "var(--safe-right)" in rule[1], name
    for rule in re.findall(r"\n    (header|#search-dock|#toast-container) \{(.*?)\n    \}", template, re.S):
        assert "var(--safe-" in rule[1], rule[0]
