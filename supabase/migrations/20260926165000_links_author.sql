-- links.author: who published the linked item on its platform, shown after
-- the domain (a YouTube video reads "youtube@Channel5YouTube"). A handle is
-- stored with its "@"; anything else is a display name. Filled by the ingest
-- functions; null when unknown.
alter table public.links
  add column author text check (char_length(author) between 1 and 100);
