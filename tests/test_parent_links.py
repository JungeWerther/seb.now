"""Enforces a review rule: every page's meta line is one component, and links its parent.

Kinds, topics, entities and indexicals each sit under something: a kind or
topic under the one a level up, an entity or an indexical under its kind. The
line under a page's title (templates/index.html) is always drawn by
`showPageMeta`, whose parent part is a `parentLink(...)` to the parent's page,
so the tree can be walked up as well as down. The line never shows the page's
raw id or path (`culture.styles.post_1945_architecture_design.brutalist`); the
parent link is how the hierarchy shows. A page with no parent goes in
`FLAT_PAGES` with a one-line reason; stale entries fail.

A page that is itself a node of a tree (its parent link opens the same kind of
page it is: a kind's parent is a kind, a topic's a topic) also lists its
children, exactly one level below it, in its Kinds section via
`showChildKinds(path, nodes, chipKind)`, passing its own `path`; the component
itself keeps only the nodes one level below it, so no caller can list more.
"""

import re

from test_search_marks_pages import _function_body, _source

FLAT_PAGES = {
    "focusLink": "a post; its entities and topics are chips, it has no parent",
    "focusTerm": "a name's senses, each linked as a chip; the words have no parent",
    "focusOrder": "a sort order, which sits in no tree",
}

# The identifiers a page function holds its own id or path in.
RAW_IDS = ("path", "id", "term", "sort")


def _page_functions(source: str) -> list[str]:
    return re.findall(
        r"^\s*(?:async )?function (focus[A-Z]\w*)\(", source, re.MULTILINE
    )


def _calls(body: str, name: str) -> list[str]:
    """The argument text of every `name(...)` call in `body`."""
    calls = []
    for match in re.finditer(rf"\b{name}\(", body):
        depth, start = 0, match.end() - 1
        for i in range(start, len(body)):
            depth += {"(": 1, ")": -1}.get(body[i], 0)
            if depth == 0:
                calls.append(body[start + 1 : i])
                break
    return calls


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
        and not any(
            "parentLink(" in call
            for call in _calls(_function_body(source, page), "showPageMeta")
        )
    ]
    assert not missing, (
        "These pages don't link their parent: draw the meta line with "
        "showPageMeta(element, [relation, parentLink(label, setXHref, id)], ...facts), "
        "or list the page in FLAT_PAGES with a reason:\n" + "\n".join(missing)
    )


def test_meta_lines_are_drawn_by_show_page_meta() -> None:
    source = _source().replace(_function_body(_source(), "showPageMeta"), "")
    writes = re.findall(
        r"""getElementById\("focus-\w+-meta"\)\.(?:replaceChildren\([^)]+\)|textContent = (?!"")[^;]+)""",
        source,
    )
    assert not writes, (
        "A page's meta line is filled outside showPageMeta:\n" + "\n".join(writes)
    )


def test_meta_lines_show_no_raw_id() -> None:
    source = _source()
    leaks = []
    for page in _page_functions(source):
        for call in _calls(_function_body(source, page), "showPageMeta"):
            shown = call
            for link in _calls(call, "parentLink"):
                shown = shown.replace(link, "")
            leaks += [
                f"{page}: showPageMeta({call})"
                for raw in RAW_IDS
                if re.search(rf"(?<![.\w]){raw}\b", shown)
            ]
    assert not leaks, "These meta lines show a page's raw id or path:\n" + "\n".join(
        leaks
    )


def _route(source: str, setter: str) -> str | None:
    match = re.search(r"anchor\.href = `/(\w+)/", _function_body(source, setter))
    return match and match.group(1)


def _tree_pages(source: str) -> list[str]:
    """The pages whose parent opens a page like their own (a kind's kind)."""
    pages = []
    for page in _page_functions(source):
        body = _function_body(source, page)
        own = re.search(r"enterFocus\(`/(\w+)/", body)
        setters = {
            re.split(r",\s*", link)[1]
            for link in _calls(body, "parentLink")
            if link.count(",") >= 2
        }
        if own and any(_route(source, setter) == own.group(1) for setter in setters):
            pages.append(page)
    return pages


def test_child_kinds_are_one_level_below_the_page() -> None:
    source = _source()
    assert re.search(
        r"\.filter\(\(\{ id \}\) => isChildPath\(path\)\(id\)\)",
        _function_body(source, "showChildKinds"),
    ), "showChildKinds no longer keeps only the nodes one level below the page's path"
    one_level = re.search(
        r"const isChildPath = \(parent\) => \(child\) =>([^;]+);", source
    )
    assert one_level and 'split(".").length + 1' in one_level.group(1), (
        "isChildPath no longer means exactly one level down"
    )


def test_every_tree_page_lists_its_children() -> None:
    source = _source()
    pages = _tree_pages(source)
    assert {"focusKind", "focusTopic"} <= set(pages), (
        f"tree pages not recognised: {pages}"
    )
    missing = [
        page
        for page in pages
        if not any(
            re.match(r"\s*path\s*,", call)
            for call in _calls(_function_body(source, page), "showChildKinds")
        )
    ]
    assert not missing, (
        "These tree pages don't list their children: call showChildKinds(path, nodes, chipKind) "
        "with the page's own path:\n" + "\n".join(missing)
    )


def test_flat_pages_exist() -> None:
    stale = set(FLAT_PAGES) - set(_page_functions(_source()))
    assert not stale, f"FLAT_PAGES names pages that no longer exist: {sorted(stale)}"
