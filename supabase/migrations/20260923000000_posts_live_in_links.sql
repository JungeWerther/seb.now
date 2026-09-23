-- Blog post content moves into `links` itself (slug + full markdown body),
-- replacing the earlier design of posts as Markdown files in the git repo
-- synced in by local-post-ingest. A post is now genuinely just a link row
-- with extra content - no separate file store, no separate sync function.
-- body_markdown is null for every non-local origin; slug is only
-- meaningful (and only used) for origin = 'local' rows, to build each
-- post's own static page path (seb.now/posts/<slug>/).
alter table public.links add column slug text;
alter table public.links add column body_markdown text;

create unique index links_slug_idx on public.links (slug) where slug is not null;

update public.links
set
  slug = 'hello-world',
  body_markdown = $md$This is the first post published through seb.now's own pipeline: a row
in the `links` table, rendered to a static page at build time, and
showing up in the feed exactly like any other link - voteable,
greyable-on-visit, all of it.

No CMS, no login, no files in the repo. To publish, a new `links` row is
inserted directly with `origin: 'local'`, a `slug`, and `body_markdown`
set.
$md$
where url = 'https://seb.now/posts/hello-world/';
