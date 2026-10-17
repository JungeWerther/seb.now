-- "Work" reads as a job in the search box's tags ("night" tagged "work").
-- The kind is a creative or informational work (a song, a film, a book, a
-- show, a game), so its label says so. Only the label changes: the path
-- (entity.artifact.work), which entities.kind_path points at, stays, and so
-- does "work" as a typed name (the path's last segment).
update public.kinds
set label = 'Creative work'
where path = 'entity.artifact.work' and label = 'Work';
