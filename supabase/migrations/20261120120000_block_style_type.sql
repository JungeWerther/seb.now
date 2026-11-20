-- The block look (square, outlined, extruded down-right with the corners joined
-- diagonally) as a style type, so readers can pick or make their own in
-- Appearance. Its tokens are the page's --block-* custom properties
-- (src/seb_now/templates/block.css declares their defaults), and the built-in
-- style below is the site's own look, written into every page at build time.
-- Additive only: one kind and one entity, nothing existing changes.
insert into public.kinds (path, label, description, schema) values (
  'entity.style.block', 'Blocks', 'The square, outlined and extruded look of cards, chips, buttons and dialogs',
  '{"properties": {
    "block_depth": {"$ref": "#/$defs/length", "description": "How far the extrusion reaches down and right; chips and small buttons take half"},
    "block_line": {"$ref": "#/$defs/length", "description": "The outline''s width"},
    "block_radius": {"$ref": "#/$defs/length", "description": "Corner rounding; 0 is square"},
    "block_ink": {"$ref": "#/$defs/color", "description": "Outline and extrusion colour on a light page"},
    "block_ink_dark": {"$ref": "#/$defs/color", "description": "Outline and extrusion colour on a dark page or band"}
  }}'
);
insert into public.entities (name, kind, kind_path, description, style) values (
  'seb.now block', 'style', 'entity.style.block', 'The site''s default block look',
  '{"block_depth": "5px", "block_line": "2px", "block_radius": "0", "block_ink": "#111111", "block_ink_dark": "#e8e8e8"}'
);
