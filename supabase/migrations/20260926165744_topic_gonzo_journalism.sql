insert into public.topics (id, name, description) values
  ('media.gonzo_journalism', 'Gonzo Journalism', 'First-person, immersive reporting where the journalist is part of the story, such as Channel 5 with Andrew Callaghan.')
on conflict (id) do nothing;
