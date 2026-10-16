-- Every Jev request the Edge Functions make, failed ones included, written by
-- JevClient (functions/_shared/jev.ts): what was asked (state + questions),
-- what came back (answers with their full probabilities), usage and timing.
-- The tables the functions fill keep only their thresholded results; this is
-- the raw record, for evaluating and re-fitting thresholds without paying for
-- the calls again. service_role only (RLS on, no policies).
create table public.jev_calls (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  fn text not null,
  link_id uuid references public.links (id) on delete set null,
  dry_run boolean not null default false,
  requested_model text not null,
  model text,
  state jsonb not null,
  questions jsonb not null,
  answers jsonb,
  input_tokens integer,
  output_tokens integer,
  attempts integer not null,
  duration_ms integer not null,
  error text,
  check ((answers is null) <> (error is null))
);

create index jev_calls_created_at on public.jev_calls (created_at desc);
create index jev_calls_link on public.jev_calls (link_id) where link_id is not null;
create index jev_calls_fn_created_at on public.jev_calls (fn, created_at desc);

alter table public.jev_calls enable row level security;
revoke all on public.jev_calls from anon, authenticated;
