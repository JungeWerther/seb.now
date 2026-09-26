-- links is written only by service_role (ingest functions, blog posts).
-- Anonymous sign-ins make every visitor `authenticated`, so a client-side
-- insert path let any visitor publish a post (body_markdown) or feed link.
drop policy if exists "users can submit their own links" on public.links;
drop policy if exists "users can delete their own links" on public.links;
revoke insert, update, delete on public.links from anon, authenticated;
