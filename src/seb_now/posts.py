"""Blog posts: rows in `public.links` (origin='local') that carry a slug
and a full markdown body, rendered to a static page per post at build
time. Content lives in the database, not in this repo - publishing a post
means inserting a links row directly, not committing a file.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Sequence

from seb_now.auth import get_unauthenticated_client
from seb_now.domain.models import Link
from seb_now.sanitize import render_markdown, safe_http_url

SITE_URL = "https://seb.now"
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


def post_from_link(link: Link) -> Post:
    assert link.slug is not None
    assert link.body_markdown is not None
    return Post(
        slug=link.slug,
        title=link.title,
        date=link.created_at.date().isoformat(),
        description=link.description or "",
        image=safe_http_url(link.image_url),
        body_html=render_markdown(link.body_markdown, MARKDOWN_EXTENSIONS),
    )


def load_posts() -> list[Post]:
    client = get_unauthenticated_client()
    response = (
        client.table(Link.__tablename__)
        .select("*")
        .eq("origin", "local")
        .not_.is_("slug", "null")
        .not_.is_("body_markdown", "null")
        .order("created_at", desc=True)
        .execute()
    )
    links = [Link.model_validate(row) for row in response.data]
    return [post_from_link(link) for link in links]


def render_post(post: Post) -> str:
    og_image_tag = f'<meta property="og:image" content="{escape(post.image)}">' if post.image else ""
    cover_tag = f'<img class="cover" src="{escape(post.image)}" alt="" loading="lazy">' if post.image else ""
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
  {og_image_tag}
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
    .cover {{
      width: 100%;
      max-height: 220px;
      object-fit: cover;
      border-radius: 14px;
      display: block;
      margin: 1rem 0;
    }}
    .byline {{ color: gray; font-size: 0.85rem; margin: 0.3rem 0 2rem; }}
    h1 {{ margin-bottom: 0.3rem; font-family: 'Bricolage Grotesque', sans-serif; }}
    article img {{ max-width: 100%; border-radius: 6px; }}
    article pre {{ overflow-x: auto; padding: 0.8rem; background: rgba(128, 128, 128, 0.12); border-radius: 6px; }}
    article code {{ font-size: 0.9em; }}
  </style>
</head>
<body>
  <a class="back" href="{SITE_URL}/">&larr; seb.now</a>
  {cover_tag}
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
