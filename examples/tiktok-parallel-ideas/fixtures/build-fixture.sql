-- build-fixture.sql — synthetic product_sales table for the tiktok-parallel-ideas flow.
--
-- Build:  duckdb fixtures/fixture.duckdb -f fixtures/build-fixture.sql
--
-- Provides the `product_sales` view that select.sql queries (top-5 + bottom-5 by velocity).
-- All data is synthetic — 10 products, each with different recent vs. prior unit counts
-- so the velocity ranking is clear and deterministic.

CREATE OR REPLACE TABLE product_sales AS SELECT * FROM (VALUES
  ('p01', 'Galaxy Mug Buddy – Nebula',        18, 6),
  ('p02', 'Galaxy Mug Buddy – Sunset Fade',   15, 1),
  ('p03', 'Galaxy Mug Buddy – Pastel Sky',    12, 5),
  ('p04', 'Galaxy Mug Buddy – Color Block',   10, 4),
  ('p05', 'Galaxy Mug Buddy – Cloud Nine',     9, 5),
  ('p06', 'Galaxy Mug Buddy – Deep Ocean',     7, 5),
  ('p07', 'Galaxy Mug Buddy – Lava Flow',      6, 6),
  ('p08', 'Galaxy Mug Buddy – Arctic Frost',   5, 7),
  ('p09', 'Galaxy Mug Buddy – Ember Glow',     3, 8),
  ('p10', 'Galaxy Mug Buddy – Midnight Blue',  2, 9)
) AS t(product_id, product_title, units_recent, units_prior);
