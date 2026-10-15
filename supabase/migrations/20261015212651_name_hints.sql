-- What entity-extract's candidate finder (_shared/names.ts) reads from the
-- database instead of hand-written word lists.
--
-- word_case_stats: per language and word, how often the pages read so far
-- write it capitalised when it isn't the first word of a sentence. "dès",
-- "pour", "after" are lowercase mid-sentence, so a capital at a sentence start
-- is only position; "apple" or "paris" are capitalised wherever they stand.
-- Only prose counts: lines of at least 8 words that aren't section headings
-- (title-case headings and menus would make every word look like a name).
-- A trigger on link_content keeps the counts current, so they cover every page
-- entity-extract or event-extract stores.

create table public.word_case_stats (
  lang text not null,
  word text not null,
  capitalised integer not null default 0,
  total integer not null default 0,
  primary key (lang, word)
);
alter table public.word_case_stats enable row level security;

create or replace function public.lang_key(lang text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select coalesce(nullif(split_part(lower(btrim(lang)), '-', 1), ''), 'und') $$;

-- Words as names.ts's WORD reads them; keep the two in step.
create or replace function public.word_case_counts(body text)
returns table (word text, capitalised integer, total integer)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select public.fold_text(replace(w.word, '’', '''')),
    (count(*) filter (where left(w.word, 1) <> lower(left(w.word, 1))))::integer,
    count(*)::integer
  from regexp_split_to_table(body, '\n') as line,
    lateral regexp_split_to_table(line, '(?<=[.!?…])\s+') as sentence,
    lateral (
      select m[1] as word, n
      from regexp_matches(sentence, '([[:alpha:]](?:[[:alnum:]''’-]*[[:alnum:]])?)', 'g') with ordinality as t(m, n)
    ) w
  where line !~ '^## '
    and cardinality(regexp_split_to_array(btrim(line), '\s+')) >= 8
    and w.n > 1
    and length(w.word) between 2 and 40
  group by 1
$$;

create or replace function public.link_content_word_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.text is not null then
    update public.word_case_stats s
    set capitalised = s.capitalised - c.capitalised, total = s.total - c.total
    from public.word_case_counts(old.text) c
    where s.lang = public.lang_key(old.lang) and s.word = c.word;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.text is not null then
    insert into public.word_case_stats (lang, word, capitalised, total)
    select public.lang_key(new.lang), c.word, c.capitalised, c.total
    from public.word_case_counts(new.text) c
    order by c.word
    on conflict (lang, word) do update
      set capitalised = word_case_stats.capitalised + excluded.capitalised,
          total = word_case_stats.total + excluded.total;
  end if;
  return null;
end
$$;

create trigger link_content_word_case
after insert or update of text, lang or delete on public.link_content
for each row execute function public.link_content_word_case();

insert into public.word_case_stats (lang, word, capitalised, total)
select public.lang_key(c.lang), w.word, sum(w.capitalised), sum(w.total)
from public.link_content c, lateral public.word_case_counts(c.text) w
where c.text is not null
group by 1, 2;

-- {word: [capitalised, total]} for these words, in the page's language (all
-- languages when it has none). One value rather than rows, since PostgREST
-- caps the rows an rpc returns.
create or replace function public.word_case_rates(page_lang text, words text[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(word, jsonb_build_array(capitalised, total)), '{}'::jsonb)
  from (
    select s.word, sum(s.capitalised) as capitalised, sum(s.total) as total
    from public.word_case_stats s
    where s.word = any(words)
      and (page_lang is null or s.lang = public.lang_key(page_lang))
    group by s.word
  ) t
$$;

-- An entity name's first word, folded the way names.ts folds page words.
create or replace function public.name_first_word(name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    substring(public.fold_text(replace(name, '’', '''')) from '[[:alpha:]](?:[[:alnum:]''-]*[[:alnum:]])?'),
    '^[dl]''', '')
$$;

create index entities_first_word on public.entities (public.name_first_word(name));

-- The entity names that start with one of these (folded) words: the known
-- names a page might contain, which names.ts then looks for word by word.
create or replace function public.known_names(first_words text[], max_results integer default 3000)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(name), '{}')
  from (
    select e.name
    from public.entities e
    where public.name_first_word(e.name) = any(first_words)
      and length(e.name) >= 3
    limit max_results
  ) t
$$;

revoke execute on function public.word_case_rates(text, text[]) from public, anon, authenticated;
revoke execute on function public.known_names(text[], integer) from public, anon, authenticated;
revoke execute on function public.word_case_counts(text) from public, anon, authenticated;
revoke execute on function public.link_content_word_case() from public, anon, authenticated;

-- A hand-labelled evaluation set: the names each page's article really
-- contains, which entity-extract's {"eval": true} scores its candidates
-- against (service_role only).
create table public.entity_gold (
  link_id uuid not null references public.links (id) on delete cascade,
  name text not null,
  primary key (link_id, name)
);
alter table public.entity_gold enable row level security;
