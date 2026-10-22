-- Card styles: a reader's own look for what they write, shown on their replies
-- to everyone, with a minimum contrast between the colours that must stay
-- readable together.

-- Who a style type is for: 'page' types are picked by each reader for their
-- own page (Appearance); 'author' types are an author's look on their own
-- cards. Readers' own types are always 'page' (no column grant on this one).
alter table public.kinds
  add column style_scope text not null default 'page' check (style_scope in ('page', 'author'));

-- Colour tokens of a style type that must keep a WCAG 2 contrast ratio between
-- them: 4.5 for text on its background (AA), 3 for a non-text UI accent. Both
-- must be opaque, since a translucent colour's contrast depends on what's behind it.
create table public.style_contrast_pairs (
  kind_path ltree not null references public.kinds (path) on delete cascade,
  foreground text not null,
  background text not null,
  min_ratio numeric not null check (min_ratio between 1 and 21),
  primary key (kind_path, foreground, background)
);
alter table public.style_contrast_pairs enable row level security;
create policy "Contrast pairs are publicly readable" on public.style_contrast_pairs
  for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.style_contrast_pairs from anon, authenticated;

-- WCAG 2 relative luminance of an opaque #rrggbb colour.
create function public.relative_luminance(hex text)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 0.2126 * c[1] + 0.7152 * c[2] + 0.0722 * c[3]
  from (
    select array_agg(
      case when v <= 0.04045 then v / 12.92 else power((v + 0.055) / 1.055, 2.4) end order by i
    ) as c
    from (
      select i, ('x' || substr(hex, 2 * i, 2))::bit(8)::int / 255.0::double precision as v
      from generate_series(1, 3) as i
    ) channels
  ) linear
$$;

-- WCAG 2 contrast ratio of two opaque #rrggbb colours, 1 to 21.
create function public.contrast_ratio(a text, b text)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select (greatest(la, lb) + 0.05) / (least(la, lb) + 0.05)
  from (select public.relative_luminance(a) as la, public.relative_luminance(b) as lb) l
$$;

-- Runs after entities_check_style (names sort that way), so the style already
-- matches its type and every paired token is a colour.
create function public.entities_check_style_contrast()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  failing record;
begin
  select p.foreground, p.background, p.min_ratio,
         new.style ->> p.foreground as fg, new.style ->> p.background as bg
    into failing
    from style_contrast_pairs p
   where p.kind_path = new.kind_path
     and (length(new.style ->> p.foreground) <> 7
          or length(new.style ->> p.background) <> 7
          or contrast_ratio(new.style ->> p.foreground, new.style ->> p.background) < p.min_ratio)
   limit 1;
  if found then
    raise exception '% (%) on % (%) must be opaque with a contrast of at least %:1',
      failing.foreground, failing.fg, failing.background, failing.bg, failing.min_ratio
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger entities_check_style_contrast before insert or update of style, kind_path on public.entities
  for each row when (new.style is not null) execute function public.entities_check_style_contrast();

-- The first author type: a card's background, its text, and an accent for the
-- author's name, which is text too, so both pairs need 4.5. No built-in style: an author without one keeps the page's look,
-- which follows the reader's light or dark scheme.
insert into public.kinds (path, label, description, style_scope, schema) values (
  'entity.style.card', 'Card', 'How your replies look to everyone', 'author',
  '{"properties": {
    "card_bg": {"$ref": "#/$defs/color", "description": "The card''s background"},
    "card_fg": {"$ref": "#/$defs/color", "description": "Its text"},
    "card_accent": {"$ref": "#/$defs/color", "description": "The author''s name"}
  }}'
);
insert into public.style_contrast_pairs (kind_path, foreground, background, min_ratio) values
  ('entity.style.card', 'card_fg', 'card_bg', 4.5),
  ('entity.style.card', 'card_accent', 'card_bg', 4.5);

-- A reader's chosen card style: one of their own, of the card type.
alter table public.profiles
  add column card_style_id uuid references public.entities (id) on delete set null;

create function public.profiles_check_card_style()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.card_style_id is not null and not exists (
    select 1 from entities e
     where e.id = new.card_style_id and e.owner_id = new.id and e.kind_path = 'entity.style.card'
  ) then
    raise exception 'a card style must be one of your own card styles' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger profiles_check_card_style before insert or update of card_style_id on public.profiles
  for each row execute function public.profiles_check_card_style();
