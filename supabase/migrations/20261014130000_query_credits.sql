-- Each account may have query-parse read its search box with Jev
-- query_credit_limit() times in all. `used` only ever counts up; a reader
-- sees their own row, and only spend_query_credit (called by query-parse as
-- that reader) writes it.
create table public.query_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  used integer not null default 0 check (used >= 0)
);

alter table public.query_credits enable row level security;

create policy "Readers see their own query credits"
  on public.query_credits for select
  to authenticated
  using (auth.uid() = user_id);

create function public.query_credit_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1000 $$;

-- Reads left for the caller (the full allowance before their first read).
create function public.query_credits_left()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select query_credit_limit() - coalesce((select used from query_credits where user_id = auth.uid()), 0)
$$;

-- Takes one read from the caller's allowance and returns what's left after
-- it, or null (taking nothing) when none are left or there is no caller.
create function public.spend_query_credit()
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into query_credits as c (user_id, used)
  select auth.uid(), 1
  where auth.uid() is not null
  on conflict (user_id) do update set used = c.used + 1
    where c.used < query_credit_limit()
  returning query_credit_limit() - used
$$;

revoke execute on function public.spend_query_credit() from public, anon;
grant execute on function public.spend_query_credit() to authenticated;
grant execute on function public.query_credits_left() to authenticated;
