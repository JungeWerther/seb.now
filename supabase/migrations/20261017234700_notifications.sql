-- A reader's inbox: one row per reply someone else posted that concerns them.
--
-- Two kinds, both about replies:
--   reply_to_you    a reply addressed to one of your replies (today only a
--                   fediverse reply whose inReplyTo is your comment's note,
--                   since the page itself has no threaded replies);
--   reply_on_thread a reply on a link you have replied on.
-- A reply that is both reaches its target once, as reply_to_you.
--
-- Rows are written only by the replies insert trigger (security definer) and
-- go away with their reply. Readers see and mark read only their own.

-- The reply a fediverse reply answers, when it answers one of ours. Set by the
-- activitypub function from the note's inReplyTo.
alter table public.replies
  add column in_reply_to_id uuid references public.replies(id) on delete set null;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('reply_to_you', 'reply_on_thread')),
  reply_id uuid not null references public.replies(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- A unique index, not a constraint: PostgREST reads a unique constraint over
-- two foreign keys as a many-to-many join, which would make embedding profiles
-- from replies ambiguous.
create unique index notifications_recipient_reply_key on public.notifications (recipient_id, reply_id);
create index notifications_recipient_created_at_idx on public.notifications (recipient_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_id) where read_at is null;
create index notifications_reply_id_idx on public.notifications (reply_id);
create index replies_in_reply_to_id_idx on public.replies (in_reply_to_id) where in_reply_to_id is not null;

alter table public.notifications enable row level security;

create policy "readers see their own notifications"
  on public.notifications for select
  to authenticated
  using (recipient_id = auth.uid());

create policy "readers mark their own notifications read"
  on public.notifications for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create function public.notify_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  if new.in_reply_to_id is not null then
    select author_id into target from public.replies where id = new.in_reply_to_id;
    if target is not null and target is distinct from new.author_id then
      insert into public.notifications (recipient_id, kind, reply_id)
      values (target, 'reply_to_you', new.id)
      on conflict (recipient_id, reply_id) do nothing;
    end if;
  end if;

  insert into public.notifications (recipient_id, kind, reply_id)
  select distinct r.author_id, 'reply_on_thread', new.id
  from public.replies r
  where r.link_id = new.link_id
    and r.id <> new.id
    and r.author_id is not null
    and r.author_id is distinct from new.author_id
  on conflict (recipient_id, reply_id) do nothing;

  return null;
end;
$$;

revoke execute on function public.notify_reply() from public, anon, authenticated;

create trigger replies_notify
  after insert on public.replies
  for each row
  execute function public.notify_reply();

-- Marks the caller's given notifications read (the ones the inbox showed, so
-- one arriving meanwhile stays unread); returns how many changed.
create function public.mark_notifications_read(ids uuid[])
returns integer
language sql
security invoker
set search_path = public
as $$
  with marked as (
    update public.notifications set read_at = now()
    where id = any(ids) and recipient_id = auth.uid() and read_at is null
    returning 1
  )
  select count(*)::integer from marked
$$;

revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
