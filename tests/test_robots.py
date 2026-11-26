"""seb.now/robots.txt: everyone welcome, the crawlers crawler_agents.robots_disallow
names sent away from the whole site, and no token able to inject a line."""

from pathlib import Path

import pytest

from seb_now.constants import ROBOTS_TXT_DISALLOW_ALL, ROBOTS_TXT_PATH
from seb_now.robots import render_robots_txt, write_robots_txt
from seb_now.site import CrawlerAgentRow, crawler_tokens, robots_disallowed


def groups(text: str) -> list[list[str]]:
    """The file's rule groups, comments left out, one list of lines each."""
    lines = [line for line in text.splitlines() if not line.startswith("#")]
    return [group.splitlines() for group in "\n".join(lines).strip().split("\n\n")]


def test_every_reader_is_allowed_by_default() -> None:
    assert groups(render_robots_txt([])) == [["User-agent: *", "Allow: /"]]


def test_the_disallowed_crawlers_share_one_group_disallowed_everywhere() -> None:
    text = render_robots_txt(["oai-searchbot", "googlebot", "gptbot"])
    assert groups(text)[-1] == [
        "User-agent: googlebot",
        "User-agent: gptbot",
        "User-agent: oai-searchbot",
        ROBOTS_TXT_DISALLOW_ALL,
    ]
    assert ["User-agent: *", "Allow: /"] in groups(text)


def test_a_token_listed_twice_is_named_once() -> None:
    assert render_robots_txt(["gptbot", "gptbot"]).count("User-agent: gptbot") == 1


@pytest.mark.parametrize("token", ["gptbot\nAllow: /", "googlebot Disallow", "bot#x", "mj12bot", ""])
def test_a_token_cannot_add_a_line_or_rule(token: str) -> None:
    with pytest.raises(ValueError, match="product token"):
        render_robots_txt([token])


def test_it_is_written_at_the_site_root(tmp_path: Path) -> None:
    path = write_robots_txt(tmp_path, ["gptbot"])
    assert path == tmp_path / ROBOTS_TXT_PATH
    assert "User-agent: gptbot\nDisallow: /\n" in path.read_text()


def test_only_flagged_crawlers_are_disallowed_but_every_crawler_skips_the_session() -> None:
    agents = [
        CrawlerAgentRow(token="googlebot", robots_disallow=True),
        CrawlerAgentRow(token="claudebot", robots_disallow=False),
        CrawlerAgentRow(token="gptbot", robots_disallow=True),
    ]
    assert robots_disallowed(agents) == ["googlebot", "gptbot"]
    assert crawler_tokens(agents) == ["claudebot", "googlebot", "gptbot"]
