-- nace_activities.path: each code's place in the NACE tree as an ltree
-- (52.32 → 'H.52.52_3.52_32'; ltree labels can't hold a dot), so
-- `'H.52' @> path` selects a division and everything under it without a
-- recursive walk over parent_code, the same way topics are queried. The table
-- is fixed reference data, so the path is filled once here.
alter table public.nace_activities add column path extensions.ltree;

with recursive tree as (
  select code, replace(code, '.', '_')::extensions.ltree as path
  from public.nace_activities where parent_code is null
  union all
  select n.code, t.path || replace(n.code, '.', '_')
  from public.nace_activities n join tree t on n.parent_code = t.code
)
update public.nace_activities n set path = t.path from tree t where t.code = n.code;

alter table public.nace_activities alter column path set not null;
create index nace_activities_path_idx on public.nace_activities using gist (path);
