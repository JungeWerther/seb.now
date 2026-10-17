"""Enforces a review rule: every page of a thing in a hierarchy links its parent.

Kinds, topics, entities and indexicals each sit under something: a kind or
topic under the one a level up, an entity or an indexical under its kind. Their
pages (the `focus*` functions in templates/index.html) say so in the band's
meta line ("a kind of <parent>"), as a link to the parent's page, so the tree
can be walked up as well as down. A page with no parent goes in `FLAT_PAGES`
with a one-line reason; stale entries fail.
"""

import re

from test_search_marks_pages import _function_body, _source

FLAT_PAGES = {
    "focusLink": "a post; its entities and topics are chips, it has no parent",
    "focusTerm": "a name's senses, each linked as a chip; the words have no parent",
    "focusOrder": "a sort order, which sits in no tree",
}

PARENT_HREF = re.compile(r"set(?:Kind|Topic)Href\(")
META_FILLED = re.compile(r"""getElementById\("focus-\w+-meta"\)\.replaceChildren\(""")


def _page_functions(source: str) -> list[str]:
    return re.findall(
        r"^\s*(?:async )?function (focus[A-Z]\w*)\(", source, re.MULTILINE
    )


def test_every_page_links_its_parent() -> None:
    source = _source()
    pages = _page_functions(source)
    assert pages, (
        "no focus* page functions found in index.html — have they been renamed?"
    )
    missing = [
        page
        for page in pages
        if page not in FLAT_PAGES
        and not (
            PARENT_HREF.search(body := _function_body(source, page))
            and META_FILLED.search(body)
        )
    ]
    assert not missing, (
        "These pages don't link their parent kind or topic from the band's meta line "
        "(a set*Href'd link in focus-*-meta); add one, or list the page in FLAT_PAGES "
        "with a reason:\n" + "\n".join(missing)
    )


def test_flat_pages_exist() -> None:
    stale = set(FLAT_PAGES) - set(_page_functions(_source()))
    assert not stale, f"FLAT_PAGES names pages that no longer exist: {sorted(stale)}"
