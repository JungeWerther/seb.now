"""Blog posts: authored as Markdown files under `posts/`, rendered to a
static page per post. Frontmatter is a plain `key: value` block (not full
YAML - the fields here are flat strings, so a real YAML parser would only
add a dependency for syntax this format never uses).
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Sequence

import markdown

SITE_URL = "https://seb.now"
POSTS_DIR = Path(__file__).parent.parent.parent / "posts"
FRONTMATTER_FENCE = "---"
MARKDOWN_EXTENSIONS = ["extra", "sane_lists"]


@dataclass(frozen=True)
class Post:
    slug: str
    title: str
    date: str
    description: str
    body_html: str
    image: str | None = None

    @property
    def url(self) -> str:
        return f"{SITE_URL}/posts/{self.slug}/"


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != FRONTMATTER_FENCE:
        return {}, text
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == FRONTMATTER_FENCE:
            fields = {}
            for field_line in lines[1:i]:
                if ":" not in field_line:
                    continue
                key, _, value = field_line.partition(":")
                fields[key.strip()] = value.strip()
            body = "\n".join(lines[i + 1 :]).strip()
            return fields, body
    return {}, text


def _slug_from_filename(path: Path) -> str:
    return path.stem


def load_post(path: Path) -> Post:
    fields, body = _parse_frontmatter(path.read_text())
    slug = fields.get("slug") or _slug_from_filename(path)
    return Post(
        slug=slug,
        title=fields.get("title", slug),
        date=fields.get("date", ""),
        description=fields.get("description", ""),
        image=fields.get("image") or None,
        body_html=markdown.markdown(body, extensions=MARKDOWN_EXTENSIONS),
    )


def load_posts(posts_dir: Path = POSTS_DIR) -> list[Post]:
    if not posts_dir.is_dir():
        return []
    posts = [load_post(path) for path in sorted(posts_dir.glob("*.md"))]
    return sorted(posts, key=lambda post: post.date, reverse=True)


def render_post(post: Post) -> str:
    image_tag = f'<meta property="og:image" content="{escape(post.image)}">' if post.image else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(post.title)} — seb.now</title>
  <meta name="description" content="{escape(post.description)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{escape(post.title)}">
  <meta property="og:description" content="{escape(post.description)}">
  <meta property="og:url" content="{escape(post.url)}">
  {image_tag}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap" rel="stylesheet">
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #1a1a1a;
      --positive: #4c9a6a;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{ --bg: #0a0a0a; --fg: #e8e8e8; --positive: #7fc999; }}
    }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 680px;
      margin: 2rem auto;
      padding: 0 1rem;
      line-height: 1.6;
      background: var(--bg);
      color: var(--fg);
    }}
    a.back {{ color: var(--positive); text-decoration: none; font-size: 0.9rem; }}
    a.back:hover {{ text-decoration: underline; }}
    .byline {{ color: gray; font-size: 0.85rem; margin: 0.3rem 0 2rem; }}
    h1 {{ margin-bottom: 0.3rem; font-family: 'Bricolage Grotesque', sans-serif; }}
    article img {{ max-width: 100%; border-radius: 6px; }}
    article pre {{ overflow-x: auto; padding: 0.8rem; background: rgba(128, 128, 128, 0.12); border-radius: 6px; }}
    article code {{ font-size: 0.9em; }}
  </style>
</head>
<body>
  <a class="back" href="{SITE_URL}/">&larr; seb.now</a>
  <h1>{escape(post.title)}</h1>
  <p class="byline">{escape(post.date)}</p>
  <article>
{post.body_html}
  </article>
</body>
</html>
"""


def write_posts(posts: Sequence[Post], output_dir: Path) -> None:
    for post in posts:
        post_dir = output_dir / "posts" / post.slug
        post_dir.mkdir(parents=True, exist_ok=True)
        (post_dir / "index.html").write_text(render_post(post))
