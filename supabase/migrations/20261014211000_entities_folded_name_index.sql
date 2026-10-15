-- match_entities compares fold_text(name) against each typed word with
-- like '%word%'; a trigram index on that expression keeps it fast.
create index entities_name_folded_trgm_idx on public.entities using gin (public.fold_text(name) extensions.gin_trgm_ops);
