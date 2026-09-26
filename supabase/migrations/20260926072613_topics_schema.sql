-- topics: a fixed, human-named taxonomy that links are tagged against, so a
-- user's likes/dislikes can be expressed per named topic (and explained back
-- to them) rather than per anonymous cluster. The id is an ltree path
-- ('ai.agents'), so the hierarchy lives in the key itself: `'ai' @> id`
-- selects a parent and all its descendants without a recursive query.
-- Links are tagged with leaf topics only; parents derive their weight from
-- their children.
create extension if not exists ltree with schema extensions;

create table public.topics (
  id extensions.ltree primary key,
  name text not null,
  description text not null,
  created_at timestamptz not null default now()
);

alter table public.topics enable row level security;

create policy "topics are publicly readable"
  on public.topics for select
  to anon, authenticated
  using (true);

-- link_topics: a link's fuzzy topic labels, p in (0, 1] per topic. Written
-- only via service_role (hand labels now, Jev later), distinguished by
-- labeled_by so the two can be compared.
create table public.link_topics (
  link_id uuid not null references public.links(id) on delete cascade,
  topic_id extensions.ltree not null references public.topics(id) on update cascade,
  p real not null check (p > 0 and p <= 1),
  labeled_by text not null check (labeled_by in ('manual', 'jev')),
  labeled_at timestamptz not null default now(),
  primary key (link_id, topic_id)
);

create index link_topics_topic_id_idx on public.link_topics using gist (topic_id);

alter table public.link_topics enable row level security;

create policy "link topics are publicly readable"
  on public.link_topics for select
  to anon, authenticated
  using (true);

insert into public.topics (id, name, description) values
  ('ai', 'AI', 'Artificial intelligence and machine learning.'),
  ('ai.models', 'AI models', 'New model releases, benchmarks, model comparisons and capabilities of specific LLMs or other AI models.'),
  ('ai.agents', 'AI agents', 'Autonomous AI agents, agentic tooling, coding agents and agent frameworks, including incidents caused by agents.'),
  ('ai.research', 'AI research', 'Machine learning research, techniques, architectures and explainers of how models work.'),
  ('ai.industry', 'AI industry', 'The AI business: deals, compute and data center buildouts, AI company strategy and AI startup funding.'),
  ('ai.safety_policy', 'AI safety & policy', 'AI regulation, safety, ethics, critique of AI hype, and the societal impact of AI.'),

  ('security', 'Security', 'Computer security and privacy.'),
  ('security.breaches', 'Breaches & hacks', 'Data breaches, hacks of organizations, and leaked or exposed data.'),
  ('security.vulnerabilities', 'Vulnerabilities', 'Security vulnerabilities, exploits, CVEs, cryptography weaknesses and security research write-ups.'),
  ('security.surveillance_privacy', 'Surveillance & privacy', 'Surveillance technology, government or corporate monitoring, and personal privacy.'),
  ('security.cybercrime', 'Cybercrime', 'Criminal hacking groups, ransomware, fraud and crypto theft.'),

  ('software', 'Software', 'Software engineering and the craft of programming.'),
  ('software.programming', 'Programming', 'Programming languages, techniques, algorithms and performance work.'),
  ('software.devtools', 'Developer tools', 'Editors, IDEs, version control, CI, debuggers and other tools developers use.'),
  ('software.open_source', 'Open source', 'Open-source projects, communities, licensing and the sustainability of open source.'),
  ('software.infrastructure', 'Infrastructure', 'Databases, cloud, networking, distributed systems and outages.'),
  ('software.operating_systems', 'Operating systems', 'Linux, Windows, macOS, mobile OSes, desktop environments and OS internals.'),

  ('hardware', 'Hardware', 'Physical computing hardware and devices.'),
  ('hardware.chips', 'Chips', 'CPUs, GPUs, semiconductors and chip manufacturing.'),
  ('hardware.gadgets', 'Gadgets', 'Consumer devices: phones, laptops, wearables, smart glasses and trackers.'),
  ('hardware.robotics', 'Robotics', 'Robots, automation hardware and robotics startups.'),
  ('hardware.retro_computing', 'Retro computing', 'Vintage computers, emulation and computing history.'),

  ('science', 'Science', 'The natural and formal sciences.'),
  ('science.physics_space', 'Physics & space', 'Physics, astronomy, space missions and spaceflight.'),
  ('science.biology_medicine', 'Biology & medicine', 'Biology, medicine, health research and drug development.'),
  ('science.mathematics', 'Mathematics', 'Mathematics, proofs and mathematical explainers.'),

  ('energy_climate', 'Energy & climate', 'Energy systems and the climate.'),
  ('energy_climate.energy', 'Energy', 'Power generation: nuclear, solar, geothermal, the grid and energy startups.'),
  ('energy_climate.climate', 'Climate', 'Climate change, emissions and environmental impact.'),

  ('business', 'Business', 'Companies, money and work.'),
  ('business.startups_funding', 'Startups & funding', 'Startup launches, venture capital and funding rounds outside the AI industry proper.'),
  ('business.big_tech', 'Big tech', 'Strategy, products and conduct of large tech companies.'),
  ('business.markets_ipos', 'Markets & IPOs', 'IPOs, valuations, public markets and acquisitions.'),
  ('business.work_labor', 'Work & labor', 'Jobs, hiring, layoffs, workplaces and the labor market.'),

  ('politics', 'Politics', 'Government, law and international affairs.'),
  ('politics.government_policy', 'Government & policy', 'Government action, public policy and regulation not specific to AI.'),
  ('politics.geopolitics_military', 'Geopolitics & military', 'International relations, conflicts, military and defense.'),
  ('politics.law_courts', 'Law & courts', 'Lawsuits, court rulings, investigations and legal disputes.'),
  ('politics.elections', 'Elections', 'Elections, campaigns, parties and polling.'),

  ('transport', 'Transport', 'Moving people and goods.'),
  ('transport.autonomous_vehicles', 'Autonomous vehicles', 'Self-driving cars, robotaxis and driver-assistance systems.'),
  ('transport.evs', 'Electric vehicles', 'Electric cars, trucks and their makers.'),
  ('transport.aviation_transit', 'Aviation & transit', 'Air travel, airports, public transit and trains.'),

  ('culture', 'Culture', 'Arts, history and the humanities.'),
  ('culture.visual_art', 'Visual art', 'Painting, sculpture, photography, murals, collage and art exhibitions.'),
  ('culture.design', 'Design', 'Architecture, industrial design, typography, UI and UX design.'),
  ('culture.film_music', 'Film & music', 'Films, documentaries, TV, music and performance.'),
  ('culture.history', 'History', 'Historical events, people and artifacts.'),
  ('culture.games', 'Games', 'Video games, board games and puzzles.'),
  ('culture.writing_language', 'Writing & language', 'Books, writing, essays, words and language.'),

  ('sports', 'Sports', 'Sports and athletic feats.'),
  ('sports.football', 'Football', 'Association football (soccer): clubs, leagues and tournaments like the World Cup.'),
  ('sports.us_sports', 'US sports', 'American football, basketball, baseball, hockey and US college sports.'),
  ('sports.endurance', 'Endurance sports', 'Running, cycling, triathlon, swimming and other endurance sports.'),
  ('sports.motorsport', 'Motorsport', 'Formula 1 and other motor racing.'),
  ('sports.general', 'Other sports', 'Sports and athletic records not covered by a more specific sports topic.'),

  ('media', 'Media', 'Platforms and publishing.'),
  ('media.social_platforms', 'Social platforms', 'Social networks and content platforms such as YouTube, Meta, X, TikTok and Discord, and their features and policies.'),
  ('media.journalism', 'Journalism', 'News organizations, journalism and publishing.'),

  ('promo', 'Promotion', 'Content whose main purpose is to promote something rather than report on it.'),
  ('promo.event_promotion', 'Event promotion', 'Ticket sales, discounts, speaker announcements and agendas for conferences and events.'),
  ('promo.sponsored', 'Sponsored', 'Sponsored posts, advertorials and product placements.');
