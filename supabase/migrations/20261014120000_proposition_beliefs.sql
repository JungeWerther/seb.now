-- Propositions about a link, each believed to a degree, with evidence combined
-- in the Beta monoid.
--
-- A piece of evidence is a pair of non-negative counts (for, against). Counts
-- add componentwise, (0, 0) is the identity, and addition is associative and
-- commutative, so evidence can be folded in any order (and in parallel). A
-- proposition's belief is its prior plus the fold of its evidence, read as a
-- Beta(alpha, beta) and charted onto [0, 1]^2 as (mean, confidence).
-- user_topic_preferences is the same construction, over votes.

create type public.beta_counts as (alpha double precision, beta double precision);

create function public.beta_add(a public.beta_counts, b public.beta_counts)
returns public.beta_counts
language sql
immutable
strict
parallel safe
as $$
  select row((a).alpha + (b).alpha, (a).beta + (b).beta)::public.beta_counts
$$;

create aggregate public.beta_sum(public.beta_counts) (
  sfunc = public.beta_add,
  stype = public.beta_counts,
  combinefunc = public.beta_add,
  initcond = '(0,0)',
  parallel = safe
);

-- The hook from a labeller's probability to counts: a judgement p with weight
-- w is w*p for and w*(1-p) against, so a confident labeller moves the mean and
-- a heavier one moves it further.
create function public.beta_evidence(p double precision, weight double precision default 1)
returns public.beta_counts
language sql
immutable
strict
parallel safe
as $$
  select row(weight * p, weight * (1 - p))::public.beta_counts
$$;

-- One claim about a link: `predicate` names what is claimed (`is_accurate`,
-- `is_satire`, `announces_event`, ...), `object` optionally what it's claimed
-- of. The prior defaults to the uniform Beta(1, 1). Public-read,
-- service_role-write.
create table public.propositions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links (id) on delete cascade,
  predicate text not null check (predicate ~ '^[a-z][a-z0-9_]{0,62}$'),
  object text check (char_length(object) between 1 and 300),
  prior_alpha double precision not null default 1 check (prior_alpha > 0),
  prior_beta double precision not null default 1 check (prior_beta > 0),
  created_at timestamptz not null default now(),
  unique nulls not distinct (link_id, predicate, object)
);

create index propositions_link_id_idx on public.propositions (link_id);

alter table public.propositions enable row level security;
create policy "propositions are public" on public.propositions for select to anon, authenticated using (true);

-- One row per source per proposition: the fold assumes its terms are
-- independent, so a source re-judging a claim replaces its row rather than
-- adding a second. `source` is that source's identity (`jev`, `manual`, a
-- feed's host, ...).
create table public.proposition_evidence (
  id uuid primary key default gen_random_uuid(),
  proposition_id uuid not null references public.propositions (id) on delete cascade,
  source text not null check (char_length(source) between 1 and 200),
  alpha double precision not null check (alpha >= 0),
  beta double precision not null check (beta >= 0),
  labeled_by text not null default 'manual' check (labeled_by in ('jev', 'manual')),
  created_at timestamptz not null default now(),
  check (alpha + beta > 0),
  unique (proposition_id, source)
);

alter table public.proposition_evidence enable row level security;
create policy "proposition_evidence is public" on public.proposition_evidence for select to anon, authenticated using (true);

-- `confidence` is n / (n + prior mass), n the evidence's total count: the
-- weight the evidence has against the prior in the posterior mean, so
-- mean = (1 - confidence) * prior mean + confidence * evidence mean.
create view public.proposition_beliefs
with (security_invoker = true) as
with folded as (
  select
    p0.id,
    count(ev.id)::integer as sources,
    public.beta_sum(row(ev.alpha, ev.beta)::public.beta_counts)
      filter (where ev.id is not null) as s
  from public.propositions p0
  left join public.proposition_evidence ev on ev.proposition_id = p0.id
  group by p0.id
)
select
  pr.id as proposition_id,
  pr.link_id,
  pr.predicate,
  pr.object,
  f.sources,
  pr.prior_alpha + (f.s).alpha as alpha,
  pr.prior_beta + (f.s).beta as beta,
  (pr.prior_alpha + (f.s).alpha)
    / (pr.prior_alpha + pr.prior_beta + (f.s).alpha + (f.s).beta) as mean,
  ((f.s).alpha + (f.s).beta)
    / ((f.s).alpha + (f.s).beta + pr.prior_alpha + pr.prior_beta) as confidence
from public.propositions pr
join folded f on f.id = pr.id;

grant select on public.proposition_beliefs to anon, authenticated;
