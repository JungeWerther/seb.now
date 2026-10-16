-- Finish 20261016235000_senses_and_indexicals: entity names are unique per
-- kind (entities_name_kind_key), not globally. That migration was applied by
-- hand in pieces and kept the old global constraint, which still stops a film
-- called "Tonight" from being its own entity beside the period. Dropping a
-- uniqueness constraint deletes no rows.
alter table public.entities drop constraint if exists entities_name_key;
