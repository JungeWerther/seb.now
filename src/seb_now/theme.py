"""The site's theme (templates/theme.css), inlined into every page the build renders.

Each page has one placeholder; `with_theme_css` fills it with the theme's
defaults followed by the build's style tokens, the built-in styles' values,
which `style_tokens` sets for everything rendered inside it.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import cache, wraps
from pathlib import Path

THEME_CSS_PATH = Path(__file__).parent / "templates" / "theme.css"
THEME_CSS_PLACEHOLDER = "/*__THEME_CSS__*/"

_style_tokens: ContextVar[str] = ContextVar("style_tokens", default="")


@cache
def theme_css() -> str:
    """The shared colour roles, block tokens and extrusion, read once."""
    return THEME_CSS_PATH.read_text()


def current_style_tokens() -> str:
    """The style tokens pages rendered now carry (the `:root` rule `style_tokens` set)."""
    return _style_tokens.get()


@contextmanager
def style_tokens(css: str) -> Iterator[None]:
    """Pages rendered inside this carry `css` (a `:root` rule) after the theme's defaults."""
    token = _style_tokens.set(css)
    try:
        yield
    finally:
        _style_tokens.reset(token)


def with_theme_css[**P](render: Callable[P, str]) -> Callable[P, str]:
    """Fill the page's theme placeholder with the theme and the current style tokens.

    It's style, which the pages' CSPs allow inline, so filling it after the
    script hash has been taken changes nothing the CSP covers.
    """

    @wraps(render)
    def rendered(*args: P.args, **kwargs: P.kwargs) -> str:
        return render(*args, **kwargs).replace(THEME_CSS_PLACEHOLDER, theme_css() + _style_tokens.get())

    return rendered
