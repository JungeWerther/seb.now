"""The block look (templates/block.css), inlined into every page the build renders."""

from collections.abc import Callable
from functools import cache, wraps
from pathlib import Path

BLOCK_CSS_PATH = Path(__file__).parent / "templates" / "block.css"
BLOCK_CSS_PLACEHOLDER = "/*__BLOCK_CSS__*/"


@cache
def block_css() -> str:
    """The shared block tokens and extrusion, read once."""
    return BLOCK_CSS_PATH.read_text()


def with_block_css[**P](render: Callable[P, str]) -> Callable[P, str]:
    """Fill the page's block placeholder with the shared block CSS.

    It's style, which the pages' CSPs allow inline, so filling it after the
    script hash has been taken changes nothing the CSP covers.
    """

    @wraps(render)
    def rendered(*args: P.args, **kwargs: P.kwargs) -> str:
        return render(*args, **kwargs).replace(BLOCK_CSS_PLACEHOLDER, block_css())

    return rendered
