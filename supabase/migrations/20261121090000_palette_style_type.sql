-- The site's colours as a style type, so they live in the database and can
-- change without a deploy: the page applies the built-in style at runtime
-- (src/seb_now/templates/theme.css declares the same defaults). Each role has a
-- light and a dark value; pages read them through theme.css's aliases.
-- Additive: one kind and one built-in style; plus the built-in block style's ink
-- moves to the matching ultramarine (mixed with a little burnt umber), which
-- changes only that built-in row.
insert into public.kinds (path, label, description, schema) values (
  'entity.style.palette', 'Colours', 'The site''s colour roles, each for light and dark pages',
  '{"properties": {
    "color_text": {"$ref": "#/$defs/color", "description": "Body text, on a light page"},
    "color_text_dark": {"$ref": "#/$defs/color", "description": "Body text, on a dark page"},
    "color_page": {"$ref": "#/$defs/color", "description": "The page behind everything, on a light page"},
    "color_page_dark": {"$ref": "#/$defs/color", "description": "The page behind everything, on a dark page"},
    "color_card": {"$ref": "#/$defs/color", "description": "Cards, bubbles and other surfaces, on a light page"},
    "color_card_dark": {"$ref": "#/$defs/color", "description": "Cards, bubbles and other surfaces, on a dark page"},
    "color_accent": {"$ref": "#/$defs/color", "description": "Highlights: icons, tags, links, upvotes, the primary button, on a light page"},
    "color_accent_dark": {"$ref": "#/$defs/color", "description": "Highlights: icons, tags, links, upvotes, the primary button, on a dark page"},
    "color_accent_soft": {"$ref": "#/$defs/color", "description": "The accent''s tint behind highlighted things, on a light page"},
    "color_accent_soft_dark": {"$ref": "#/$defs/color", "description": "The accent''s tint behind highlighted things, on a dark page"},
    "color_muted": {"$ref": "#/$defs/color", "description": "Quiet things: downvotes, removals, secondary text, on a light page"},
    "color_muted_dark": {"$ref": "#/$defs/color", "description": "Quiet things: downvotes, removals, secondary text, on a dark page"},
    "color_muted_soft": {"$ref": "#/$defs/color", "description": "The muted colour''s tint, on a light page"},
    "color_muted_soft_dark": {"$ref": "#/$defs/color", "description": "The muted colour''s tint, on a dark page"},
    "color_alert": {"$ref": "#/$defs/color", "description": "Errors and limits reached, on a light page"},
    "color_alert_dark": {"$ref": "#/$defs/color", "description": "Errors and limits reached, on a dark page"}
  }}'
);
insert into public.entities (name, kind, kind_path, description, style) values (
  'seb.now palette', 'style', 'entity.style.palette', 'The site''s default colours',
  '{"color_text": "#1a1a1a", "color_text_dark": "#e8e8e8", "color_page": "#ffffff", "color_page_dark": "#12141f", "color_card": "#f6f6f6", "color_card_dark": "#1b1d2c", "color_accent": "#75352e", "color_accent_dark": "#c1846e", "color_accent_soft": "#f2e4df", "color_accent_soft_dark": "#36231f", "color_muted": "#6f6a64", "color_muted_dark": "#a8a29e", "color_muted_soft": "#efedea", "color_muted_soft_dark": "#26292f", "color_alert": "#b3261e", "color_alert_dark": "#f2b8b5"}'
);
update public.entities
set style = style || '{"block_ink": "#333d84", "block_ink_dark": "#8b90cf"}'
where kind_path = 'entity.style.block' and name = 'seb.now block' and owner_id is null;
