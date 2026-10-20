"""Enforces a review rule: everything the search box highlights opens a page.

The search box tags matched words in place (`tagTokens`, drawn by
`renderSearchMarks` in templates/index.html): a topic, an entity, a kind, a
period, a sort order. A tag the reader can't tap is a dead end, so each one
must carry a `page` (`markPage(name, setXHref, id)`), and each `set*Href` it
names must build an address the page actually routes: a `*_PATH_PATTERN`,
matched by `setupLinkPage` (direct visits and Back) and listed in its
chip-link click handler (taps open it in place).

When this fails because a new kind of tag was added, don't drop the
highlight: give the thing its own page (a `focus*` function, a `set*Href`
and its path pattern, routed in `setupLinkPage`) and pass it as the tag's
`page`.
"""

import re
from pathlib import Path

INDEX_HTML = Path(__file__).parent.parent / "src" / "seb_now" / "templates" / "index.html"


def _source() -> str:
    return INDEX_HTML.read_text()


def _balanced(source: str, open_at: int) -> str:
    """The text from the `{` at `open_at` to its matching `}`."""
    depth = 0
    for i in range(open_at, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[open_at : i + 1]
    raise AssertionError(f"unbalanced braces from offset {open_at}")


def _function_body(source: str, name: str) -> str:
    match = re.search(rf"function {name}\([^)]*\)\s*\{{", source)
    assert match, f"function {name} not found in index.html"
    return _balanced(source, match.end() - 1)


def _tag_literals(body: str) -> list[str]:
    return [_balanced(body, m.start()) for m in re.finditer(r"\{\s*kind\b", body)]


# A single sense's tag is built by its case in this table (`match`).
SENSE_TAGS = "tagBySenseField"


def _sense_tag_cases(source: str) -> list[str]:
    match = re.search(rf"const {SENSE_TAGS} = \{{", source)
    assert match, f"{SENSE_TAGS} not found in index.html"
    table = _balanced(source, match.end() - 1)
    starts = [m.start() for m in re.finditer(r"^\s+\w+: \(", table, re.MULTILINE)]
    return [table[a:b] for a, b in zip(starts, [*starts[1:], len(table)], strict=True)]


def _tag_sources(source: str) -> str:
    return "\n".join([_function_body(source, "tagTokens"), *_sense_tag_cases(source)])


def test_every_search_tag_has_a_page() -> None:
    source = _source()
    tags = _tag_literals(_function_body(source, "tagTokens"))
    assert tags, "tagTokens builds no tags — has it been renamed?"
    cases = _sense_tag_cases(source)
    assert cases, f"{SENSE_TAGS} has no cases"
    missing = [tag for tag in tags if "page: markPage(" not in tag and f"...match({SENSE_TAGS}" not in tag]
    missing += [case for case in cases if "page: markPage(" not in case]
    assert not missing, (
        "These search-box highlights open no page — give each its own page and pass it as "
        "`page: markPage(name, setXHref, id)`:\n" + "\n".join(missing)
    )


def test_every_search_mark_is_a_link() -> None:
    body = _function_body(_source(), "renderSearchMarks")
    assert re.search(r"t\.tag\.page|\{ page \} = t\.tag", body), "renderSearchMarks no longer reads each tag's page"
    # The only text nodes are the gaps between tags; a tag's own text never
    # falls back to plain, unclickable text.
    assert "createTextNode(text)" not in body, "renderSearchMarks leaves a highlighted word without a link"


def test_every_page_a_tag_opens_is_routed() -> None:
    source = _source()
    setters = set(re.findall(r"markPage\([^,]+,\s*(set\w+Href),", _tag_sources(source)))
    assert setters, "tagTokens names no set*Href"
    link_page = _function_body(source, "setupLinkPage")
    for setter in sorted(setters):
        body = _function_body(source, setter)
        prefix = re.search(r"anchor\.href = `/(\w+)/", body)
        assert prefix, f"{setter} doesn't build a /<prefix>/ address"
        prefix = prefix.group(1)
        pattern = re.search(rf"const (\w+_PATH_PATTERN) = new RegExp\(`\^/{prefix}/", source)
        assert pattern, f"/{prefix}/ (from {setter}) has no *_PATH_PATTERN, so nothing routes it"
        pattern = pattern.group(1)
        # Routed directly, or through a helper like kindPathFromPath().
        readers = {pattern} | {
            m.group(1)
            for m in re.finditer(r"function (\w+)\(\)\s*\{\s*return location\.pathname\.match\((\w+)\)", source)
            if m.group(2) == pattern
        }
        assert any(reader in link_page for reader in readers), f"setupLinkPage never opens /{prefix}/ pages"
        assert f"a[href^='/{prefix}/']" in link_page, f"the chip-link click handler doesn't open /{prefix}/ in place"
