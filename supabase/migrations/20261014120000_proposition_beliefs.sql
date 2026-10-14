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

-- A judgement p made n times is n*p for and n*(1-p) against.
create function public.beta_evidence(p double precision, n double precision default 1)
returns public.beta_counts
language sql
immutable
strict
parallel safe
as $$
  select row(n * p, n * (1 - p))::public.beta_counts
$$;

-- A monoid homomorphism (it commutes with beta_sum), so a source's weight can be
-- applied per term or once to that source's folded counts.
create function public.beta_scale(c public.beta_counts, w double precision)
returns public.beta_counts
language sql
immutable
strict
parallel safe
as $$
  select row(w * (c).alpha, w * (c).beta)::public.beta_counts
$$;

-- Platt scaling, sigmoid(a * logit(p) + b). Not a homomorphism, so it applies to
-- each judgement before it becomes counts, never to a folded sum.
create function public.beta_calibrate(p double precision, a double precision, b double precision)
returns double precision
language sql
immutable
strict
parallel safe
as $$
  select case
    when p <= 0 then 0
    when p >= 1 then 1
    else 1 / (1 + exp(-(a * ln(p / (1 - p)) + b)))
  end
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

-- How each source's judgements are mapped before folding: Platt calibration
-- (calib_a, calib_b) and a weight in pseudo-observations. A source with no row
-- is taken as is (1, 0, 1). topic-label's row is fitted on 200 hand-labelled
-- links (research/data/topic_label_calibration_2026-10-14.csv): Jev's scores are
-- overconfident (0.94 is right 84% of the time), and beyond a weight of 16 the
-- held-out fit barely improves. Public-read, service_role-write.
create table public.evidence_sources (
  source text primary key check (char_length(source) between 1 and 200),
  calib_a double precision not null default 1 check (calib_a > 0),
  calib_b double precision not null default 0,
  weight double precision not null default 1 check (weight > 0),
  notes text,
  updated_at timestamptz not null default now()
);

alter table public.evidence_sources enable row level security;
create policy "evidence_sources are public" on public.evidence_sources for select to anon, authenticated using (true);

insert into public.evidence_sources (source, calib_a, calib_b, weight, notes) values
  ('topic-label', 0.5, -0.25, 16, 'Jev topic labels; Platt fit on 593 beam leaves of 200 hand-labelled links, 2026-10-14');

-- One judgement per source per proposition: the fold assumes its terms are
-- independent, so a source re-judging a claim replaces its row rather than
-- adding a second. `p` is the judgement as the source made it, uncalibrated, and
-- `n` how many observations it stands for (counts (alpha, beta) are p =
-- alpha / (alpha + beta), n = alpha + beta). `source` is that source's identity
-- (`topic-label`, `manual`, a feed's host, ...).
create table public.proposition_evidence (
  id uuid primary key default gen_random_uuid(),
  proposition_id uuid not null references public.propositions (id) on delete cascade,
  source text not null check (char_length(source) between 1 and 200),
  p double precision not null check (p >= 0 and p <= 1),
  n double precision not null default 1 check (n > 0),
  labeled_by text not null default 'manual' check (labeled_by in ('jev', 'manual')),
  created_at timestamptz not null default now(),
  unique (proposition_id, source)
);

alter table public.proposition_evidence enable row level security;
create policy "proposition_evidence is public" on public.proposition_evidence for select to anon, authenticated using (true);

-- Each term is f(e) = scale(evidence(calibrate(p), n), weight), with its
-- source's mapping. `confidence` is evidence mass / (evidence mass + prior
-- mass), the weight the evidence has against the prior, so
-- mean = (1 - confidence) * prior mean + confidence * evidence mean.
create view public.proposition_beliefs
with (security_invoker = true) as
with terms as (
  select
    ev.proposition_id,
    public.beta_scale(
      public.beta_evidence(public.beta_calibrate(ev.p, coalesce(s.calib_a, 1), coalesce(s.calib_b, 0)), ev.n),
      coalesce(s.weight, 1)
    ) as c
  from public.proposition_evidence ev
  left join public.evidence_sources s on s.source = ev.source
),
folded as (
  select
    p0.id,
    count(t.c)::integer as sources,
    public.beta_sum(t.c) filter (where t.c is not null) as s
  from public.propositions p0
  left join terms t on t.proposition_id = p0.id
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
