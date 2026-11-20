-- The built-in block style's ink becomes blue: a deeper pastel on light pages,
-- a light pastel on dark ones (navy in the page's own CSS). Only the built-in
-- style (no owner) changes; readers' own block styles are left alone.
update public.entities
set style = style || '{"block_ink": "#7fa8f5", "block_ink_dark": "#a9c8ff"}'
where kind_path = 'entity.style.block' and name = 'seb.now block' and owner_id is null;
