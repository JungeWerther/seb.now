-- sources is written only by service_role, like links.
revoke insert, update, delete, truncate on public.sources from anon, authenticated;
