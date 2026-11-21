"""seb.now as an installable app: its manifest, its icons and its service worker.

Everything here is drawn from what the build already knows. Colours are the
palette and block tokens (theme.css's defaults, then the built-in styles' values
from the database), so the icon and the browser chrome change with the
palette, at the next build. The app's routes are read from the page script's
own `*_PATH_PATTERN`s, so the service worker can't fall out of step with them.

- `manifest.json`: name, scope, standalone display, colours, icons, shortcuts.
- the icons: the block look (a face outlined in ink, its slab extruded
  down-right with diagonal corners) with the wordmark's accent "." on it, drawn
  with Pillow as PNGs (192 and 512 "any", 512 maskable, Apple's 180) and as an
  SVG favicon that follows the reader's colour scheme.
- `sw.js`: templates/sw.js (compiled from frontend/src/sw/sw.ts) filled with
  its version, routes and files to cache (see that file for what it does).
- the head tags: `with_app_head` (the index: manifest, theme colours, icons)
  and `with_icon_links` (every other page: just the icons).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, fields
from enum import Enum
from functools import reduce, wraps
from html import escape
from pathlib import Path

from PIL import Image, ImageDraw

from seb_now.constants import (
    APP_CATEGORY,
    APP_DESCRIPTION,
    APP_DISPLAY,
    APP_NAME,
    APP_START_URL,
    APPLE_ICON_SCALE,
    APPLE_TOUCH_ICON_PATH,
    APPLE_TOUCH_ICON_SIZE,
    FAVICON_SVG_PATH,
    GOOGLE_FONTS_FILE_ORIGIN,
    GOOGLE_FONTS_STYLESHEET_ORIGIN,
    ICON_DEPTH,
    ICON_DOT_RADIUS,
    ICON_FACE_END,
    ICON_FACE_START,
    ICON_LINE,
    ICON_PATH_TEMPLATE,
    ICON_SIZE_LARGE,
    ICON_SIZE_SMALL,
    ICON_SUPERSAMPLE,
    MANIFEST_PATH,
    MASKABLE_ICON_PATH_TEMPLATE,
    MASKABLE_SCALE,
    SERVICE_WORKER_PATH,
    SERVICE_WORKER_VERSION_LENGTH,
    SHORTCUT_LATEST_NAME,
    SHORTCUT_LATEST_URL,
    SHORTCUT_TOP_NAME,
    SHORTCUT_TOP_URL,
    SUPABASE_JS_URL,
)
from seb_now.sanitize import script_json
from seb_now.theme import current_style_tokens, theme_css

TEMPLATES_DIR = Path(__file__).parent / "templates"
SERVICE_WORKER_TEMPLATE_PATH = TEMPLATES_DIR / SERVICE_WORKER_PATH
INDEX_TEMPLATE_PATH = TEMPLATES_DIR / "index.html"

APP_HEAD_PLACEHOLDER = "<!--__APP_HEAD__-->"
ICON_LINKS_PLACEHOLDER = "<!--__ICON_LINKS__-->"
SW_VERSION_PLACEHOLDER = "__SW_VERSION__"
SW_APP_ROUTE_PREFIXES_PLACEHOLDER = "__SW_APP_ROUTE_PREFIXES__"
SW_PRECACHE_PLACEHOLDER = "__SW_PRECACHE__"
SW_PINNED_PLACEHOLDER = "__SW_PINNED__"
SW_STALE_ORIGINS_PLACEHOLDER = "__SW_STALE_ORIGINS__"

# A custom property's declaration in a stylesheet: `--color-page: #ebedf1;`.
CSS_DECLARATION = re.compile(r"(--[a-z0-9-]+)\s*:\s*([^;{}]+);")
# The first path segment of each `*_PATH_PATTERN` in the page script, written
# as a template literal (`^/e/(`) or a regex literal (`^\/p\/(`).
PATH_PATTERN_SEGMENT = re.compile(r"_PATH_PATTERN = [^\n]*?\^\\?/(\w+)\\?/")

PURPOSE_ANY = "any"
PURPOSE_MASKABLE = "maskable"
PNG_TYPE = "image/png"
SVG_TYPE = "image/svg+xml"
RGBA = "RGBA"
RGB = "RGB"
TRANSPARENT = "#00000000"
CENTRE = 0.5
CSS_PROPERTY = "css_property"


def _token(css_property: str) -> str:
    """A Palette field, read from the stylesheet's `css_property`."""
    token: str = field(metadata={CSS_PROPERTY: css_property})
    return token


@dataclass(frozen=True)
class Palette:
    """The colours the app shows outside the page: the browser chrome and the icon."""

    page: str = _token("--color-page")
    page_dark: str = _token("--color-page-dark")
    accent: str = _token("--color-accent")
    accent_dark: str = _token("--color-accent-dark")
    ink: str = _token("--block-ink")
    ink_dark: str = _token("--block-ink-dark")

    @classmethod
    def of(cls, tokens: Mapping[str, str]) -> Palette:
        return cls(**{token.name: tokens[token.metadata[CSS_PROPERTY]] for token in fields(cls)})


def css_tokens(css: str) -> dict[str, str]:
    """Every custom property a stylesheet declares, the last declaration winning."""
    return {name: value.strip() for name, value in CSS_DECLARATION.findall(css)}


def current_palette() -> Palette:
    """The theme's defaults with the build's built-in style tokens over them."""
    return Palette.of(css_tokens(theme_css() + current_style_tokens()))


def app_route_prefixes(page_template: str) -> tuple[str, ...]:
    """`/p/`, `/e/`, ...: the routes the page script opens in place."""
    return tuple(sorted({f"/{segment}/" for segment in PATH_PATTERN_SEGMENT.findall(page_template)}))


class IconKind(Enum):
    """How an icon is drawn: its manifest purpose, how much of the edge the block
    spans (around the centre) and whether its background is the page colour."""

    ANY = (PURPOSE_ANY, 1.0, False)
    # Cropped to the safe zone by the launcher, so smaller and full-bleed.
    MASKABLE = (PURPOSE_MASKABLE, MASKABLE_SCALE, True)
    # Apple draws its own rounded corners over an opaque square.
    APPLE = (PURPOSE_ANY, APPLE_ICON_SCALE, True)

    def __init__(self, purpose: str, scale: float, opaque: bool) -> None:
        self.purpose = purpose
        self.scale = scale
        self.opaque = opaque


@dataclass(frozen=True)
class Icon:
    path: str
    size: int
    kind: IconKind = IconKind.ANY


def icons() -> tuple[Icon, ...]:
    """The manifest's PNG icons."""
    return (
        Icon(ICON_PATH_TEMPLATE.format(size=ICON_SIZE_SMALL), ICON_SIZE_SMALL),
        Icon(ICON_PATH_TEMPLATE.format(size=ICON_SIZE_LARGE), ICON_SIZE_LARGE),
        Icon(MASKABLE_ICON_PATH_TEMPLATE.format(size=ICON_SIZE_LARGE), ICON_SIZE_LARGE, IconKind.MASKABLE),
    )


def apple_touch_icon() -> Icon:
    return Icon(APPLE_TOUCH_ICON_PATH, APPLE_TOUCH_ICON_SIZE, IconKind.APPLE)


@dataclass(frozen=True)
class BlockGeometry:
    """The block, in fractions of the icon's edge: its face, its slab (the face
    and its copy `depth` down-right joined by diagonals), its outline and dot."""

    face: tuple[float, float, float, float]
    slab: tuple[tuple[float, float], ...]
    line: float
    dot: tuple[float, float, float]

    @classmethod
    def scaled(cls, scale: float) -> BlockGeometry:
        # Centre the whole block (face plus slab), then shrink it around the centre.
        shift = CENTRE - (ICON_FACE_START + ICON_FACE_END + ICON_DEPTH) / 2

        def at(value: float) -> float:
            return CENTRE + (value + shift - CENTRE) * scale

        x0 = y0 = at(ICON_FACE_START)
        x1 = y1 = at(ICON_FACE_END)
        depth = ICON_DEPTH * scale
        slab = (
            (x0, y0),
            (x1, y0),
            (x1 + depth, y0 + depth),
            (x1 + depth, y1 + depth),
            (x0 + depth, y1 + depth),
            (x0, y1),
        )
        centre = (x0 + x1) / 2
        return cls(
            face=(x0, y0, x1, y1), slab=slab, line=ICON_LINE * scale, dot=(centre, centre, ICON_DOT_RADIUS * scale)
        )


def draw_icon(icon: Icon, palette: Palette) -> Image.Image:
    """The icon as a PNG-ready image, drawn large and downscaled for smooth edges."""
    edge = icon.size * ICON_SUPERSAMPLE
    geometry = BlockGeometry.scaled(icon.kind.scale)
    background = palette.page if icon.kind.opaque else TRANSPARENT
    image = Image.new(RGBA, (edge, edge), background)
    draw = ImageDraw.Draw(image)

    def px(value: float) -> float:
        return value * edge

    draw.polygon([(px(x), px(y)) for x, y in geometry.slab], fill=palette.ink)
    draw.rectangle(
        tuple(map(px, geometry.face)), fill=palette.page, outline=palette.ink, width=round(px(geometry.line))
    )
    dot_x, dot_y, radius = map(px, geometry.dot)
    draw.ellipse((dot_x - radius, dot_y - radius, dot_x + radius, dot_y + radius), fill=palette.accent)
    resized = image.resize((icon.size, icon.size), Image.Resampling.LANCZOS)
    return resized.convert(RGB) if icon.kind.opaque else resized


def favicon_svg(palette: Palette) -> str:
    """The same block as a vector, switching to the dark colours with the reader's scheme."""
    geometry = BlockGeometry.scaled(1.0)
    x0, y0, x1, y1 = geometry.face
    half_line = geometry.line / 2
    slab = " ".join(f"{x:.4f},{y:.4f}" for x, y in geometry.slab)
    dot_x, dot_y, radius = geometry.dot
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">'
        f"<style>.ink{{fill:{palette.ink}}}.face{{fill:{palette.page};stroke:{palette.ink}}}.dot{{fill:{palette.accent}}}"
        f"@media (prefers-color-scheme: dark){{.ink{{fill:{palette.ink_dark}}}"
        f".face{{fill:{palette.page_dark};stroke:{palette.ink_dark}}}.dot{{fill:{palette.accent_dark}}}}}</style>"
        f'<polygon class="ink" points="{slab}"/>'
        f'<rect class="face" x="{x0 + half_line:.4f}" y="{y0 + half_line:.4f}" width="{x1 - x0 - geometry.line:.4f}" '
        f'height="{y1 - y0 - geometry.line:.4f}" stroke-width="{geometry.line:.4f}"/>'
        f'<circle class="dot" cx="{dot_x:.4f}" cy="{dot_y:.4f}" r="{radius:.4f}"/>'
        "</svg>"
    )


def manifest(palette: Palette) -> dict[str, object]:
    return {
        "id": APP_START_URL,
        "name": APP_NAME,
        "short_name": APP_NAME,
        "description": APP_DESCRIPTION,
        "start_url": APP_START_URL,
        "scope": APP_START_URL,
        "display": APP_DISPLAY,
        "background_color": palette.page,
        "theme_color": palette.page,
        "categories": [APP_CATEGORY],
        "icons": [
            *(
                {
                    "src": f"/{icon.path}",
                    "sizes": f"{icon.size}x{icon.size}",
                    "type": PNG_TYPE,
                    "purpose": icon.kind.purpose,
                }
                for icon in icons()
            ),
            {"src": f"/{FAVICON_SVG_PATH}", "sizes": "any", "type": SVG_TYPE, "purpose": PURPOSE_ANY},
        ],
        "shortcuts": [
            {"name": SHORTCUT_LATEST_NAME, "url": SHORTCUT_LATEST_URL},
            {"name": SHORTCUT_TOP_NAME, "url": SHORTCUT_TOP_URL},
        ],
    }


def precached_paths() -> tuple[str, ...]:
    """The app's own files, cached on install (the page itself is cached as `/`)."""
    files = (MANIFEST_PATH, FAVICON_SVG_PATH, APPLE_TOUCH_ICON_PATH, *(icon.path for icon in icons()))
    return tuple(f"/{path}" for path in files)


def service_worker(index_html: str, page_template: str) -> str:
    """templates/sw.js filled in; its version is the built page's hash, so a
    deploy that changes the page replaces the worker and its cache."""
    version = hashlib.sha256(index_html.encode()).hexdigest()[:SERVICE_WORKER_VERSION_LENGTH]
    substitutions = {
        SW_VERSION_PLACEHOLDER: script_json(version),
        SW_APP_ROUTE_PREFIXES_PLACEHOLDER: script_json(list(app_route_prefixes(page_template))),
        SW_PRECACHE_PLACEHOLDER: script_json(list(precached_paths())),
        SW_PINNED_PLACEHOLDER: script_json([SUPABASE_JS_URL]),
        SW_STALE_ORIGINS_PLACEHOLDER: script_json([GOOGLE_FONTS_STYLESHEET_ORIGIN, GOOGLE_FONTS_FILE_ORIGIN]),
    }
    return reduce(lambda code, sub: code.replace(*sub), substitutions.items(), SERVICE_WORKER_TEMPLATE_PATH.read_text())


def icon_links() -> str:
    return (
        f'<link rel="icon" href="/{FAVICON_SVG_PATH}" type="{SVG_TYPE}">\n'
        f'  <link rel="apple-touch-icon" href="/{APPLE_TOUCH_ICON_PATH}">'
    )


def app_head(palette: Palette) -> str:
    return (
        f'<link rel="manifest" href="/{MANIFEST_PATH}">\n'
        f'  <meta name="theme-color" media="(prefers-color-scheme: light)" content="{escape(palette.page)}">\n'
        f'  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="{escape(palette.page_dark)}">\n'
        f'  <meta name="mobile-web-app-capable" content="yes">\n'
        f'  <meta name="apple-mobile-web-app-title" content="{escape(APP_NAME)}">\n'
        f"  {icon_links()}"
    )


def _filling(placeholder: str, head: Callable[[], str]) -> Callable[[Callable[..., str]], Callable[..., str]]:
    """A decorator that fills `placeholder` in the rendered page with `head()`.

    Head tags, outside any script, so filling them after a script hash has
    been taken changes nothing the CSP covers.
    """

    def decorate[**P](render: Callable[P, str]) -> Callable[P, str]:
        @wraps(render)
        def rendered(*args: P.args, **kwargs: P.kwargs) -> str:
            return render(*args, **kwargs).replace(placeholder, head())

        return rendered

    return decorate


with_app_head = _filling(APP_HEAD_PLACEHOLDER, lambda: app_head(current_palette()))
with_icon_links = _filling(ICON_LINKS_PLACEHOLDER, icon_links)


def _write(path: Path, content: str) -> Path:
    path.write_text(content)
    return path


def _save(path: Path, image: Image.Image) -> Path:
    image.save(path)
    return path


def write_pwa(output_dir: Path, index_html: str) -> list[Path]:
    """The manifest, icons and service worker, next to the index page."""
    palette = current_palette()
    return [
        *(_save(output_dir / icon.path, draw_icon(icon, palette)) for icon in (*icons(), apple_touch_icon())),
        _write(output_dir / FAVICON_SVG_PATH, favicon_svg(palette)),
        _write(output_dir / MANIFEST_PATH, json.dumps(manifest(palette), indent=2) + "\n"),
        _write(output_dir / SERVICE_WORKER_PATH, service_worker(index_html, INDEX_TEMPLATE_PATH.read_text())),
    ]
