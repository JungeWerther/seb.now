-- query-parse's answers, shared by every reader: the key is the lowercased
-- text and the candidate topic ids it was read with, so a query anyone has
-- had read is free for everyone after. Only query-parse (service_role) reads
-- and writes it; clients never see it (RLS on, no policies).
create table public.query_readings (
  key text primary key,
  reading jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.query_readings enable row level security;
