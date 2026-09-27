-- A PostgREST upsert sets every column it sends in its ON CONFLICT update,
-- so relabelling a link needs update on the key columns too; RLS still
-- confines it to the user's own rows.
grant update (link_id, topic_id) on public.link_topic_suggestions to authenticated;
