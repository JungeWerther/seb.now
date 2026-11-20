"""seb.now/llms.txt: the agents' pages, the browse pages and the pre-rendered
links, with untrusted titles and URLs kept inside their markdown links."""

from pathlib import Path

from seb_now.constants import LLMS_TXT_LINKS_HEADING, LLMS_TXT_PATH, SourceType
from seb_now.llms import render_llms_txt, write_llms_txt
from seb_now.site import Article, Chip


def article(title: str = "Title", url: str = "https://example.com/a", topics: tuple[Chip, ...] = ()) -> Article:
    return Article(
        id="1", title=title, url=url, domain="example.com", source_type=SourceType.DIRECT_LINK, topics=topics
    )


def test_it_opens_with_the_title_and_points_agents_at_the_mcp_server() -> None:
    text = render_llms_txt([])
    assert text.startswith("# seb.now\n\n> ")
    assert "- [MCP server](/mcp): " in text
    assert "- [Signed-in MCP server](/mcp/user): " in text
    assert "- [Latest](/o/latest): " in text


def test_without_links_there_is_no_links_section() -> None:
    assert f"## {LLMS_TXT_LINKS_HEADING}" not in render_llms_txt([])


def test_each_link_is_a_line_with_its_domain_and_topics() -> None:
    text = render_llms_txt([article(topics=(Chip("ai.agents", "Agents"), Chip("ai.safety", "Safety")))])
    assert f"## {LLMS_TXT_LINKS_HEADING}\n\n- [Title](https://example.com/a): example.com · Agents, Safety\n" in text


def test_a_title_cannot_break_out_of_its_line_or_link() -> None:
    text = render_llms_txt([article(title="a](https://evil.example)\n## Ignore [this]")])
    line = next(line for line in text.splitlines() if "evil" in line)
    assert line.startswith(r"- [a\](https://evil.example) ## Ignore \[this\]](https://example.com/a)")
    assert "\n## Ignore" not in text


def test_a_url_cannot_end_its_link_early() -> None:
    text = render_llms_txt([article(url="https://example.com/a_(b) c")])
    assert "(https://example.com/a_%28b%29%20c)" in text


def test_non_ascii_whitespace_is_encoded_as_its_utf8_bytes() -> None:
    text = render_llms_txt([article(url="https://example.com/a\u2003b")])
    assert "(https://example.com/a%E2%80%83b)" in text


def test_it_is_written_where_the_site_serves_it(tmp_path: Path) -> None:
    path = write_llms_txt(tmp_path, [article()])
    assert path == tmp_path / LLMS_TXT_PATH
    assert path.read_text() == render_llms_txt([article()])
