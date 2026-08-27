-- build-fixture.sql — generates a small, SYNTHETIC, non-sensitive DuckDB that mirrors the
-- columns fetch.sql reads from the real arcane.duckdb. No real buyer/sales data.
--
-- Build:  duckdb fixture.duckdb -f build-fixture.sql
--
-- Dates are relative to CURRENT_DATE so the fixture stays "recent" whenever it's rebuilt
-- (the velocity / recent-video windows in fetch.sql key off recency).
--
-- Story it encodes (one product, "Galaxy Mug Buddy", campaign "Spring Mugs"):
--   * Nebula  — the proven best-selling colorway (steady over weeks)
--   * Sunset Fade — a brand-new rising star (only the last few days; already a video exists,
--                   so `ideate` must feature it from a FRESH angle)
--   * 3 recent videos with real-shaped descriptions (anti-repeat signal)

CREATE OR REPLACE TABLE campaigns AS
SELECT * FROM (VALUES
  ('c1','999000111222333444','v1','Spring Mugs',120.00,18,410.0,9000,220,(CURRENT_DATE-20)::timestamp),
  ('c2','999000111222333444','v2','Spring Mugs', 80.00, 9,230.0,6000,140,(CURRENT_DATE-14)::timestamp),
  ('c3','999000111222333444','v3','Spring Mugs', 60.00, 7,190.0,5000,110,(CURRENT_DATE- 6)::timestamp),
  ('c4','999000111222333444','-', 'Spring Mugs', 40.00, 5,120.0,3000, 70,(CURRENT_DATE- 5)::timestamp)
) AS t(campaign_id, product_id, video_id, campaign_name, cost, sku_orders, gross_revenue, ad_impressions, ad_clicks, posted_at);

CREATE OR REPLACE TABLE videos AS
SELECT * FROM (VALUES
  ('v1','Galaxy Mug Buddy – 3D Printed Cup Companion','Pack an order with me! Featuring the Nebula colorway 🌌',(CURRENT_DATE-20)::timestamp,52000,410.0),
  ('v2','Galaxy Mug Buddy – 3D Printed Cup Companion','Colorway spotlight: Pastel Sky! Which should we make next?',(CURRENT_DATE-14)::timestamp,38000,230.0),
  ('v3','Galaxy Mug Buddy – 3D Printed Cup Companion','Restock alert + new Sunset Fade drop ☀️',(CURRENT_DATE-6)::timestamp,21000,190.0)
) AS t(video_id, product, description, posted_at, views, gmv);

CREATE OR REPLACE TABLE video_analysis AS
SELECT * FROM (VALUES
  ('v1','Pack-an-order fulfillment + inventory wall scan','Highly effective — friendly face plus fast cuts of colorful product.','Host opens with "Let''s pack some Galaxy Buddies!" then pans a wall of colorways.','face-to-camera-hook,inventory-wall-scan,pack-an-order,product-close-up','Tap the orange cart to grab yours','A pack-an-order video that doubles as a colorway catalog.'),
  ('v2','Colorway spotlight / comment-bait','Effective — the "which next?" question drives comments.','Close-up of the Pastel Sky buddy with a bright text overlay.','product-detail-macro,comment-bait,text-overlay,face-to-camera-outro','Comment your favorite colorway','A single-colorway spotlight asking viewers to vote on the next color.'),
  ('v3','Restock + new-drop teaser','Solid — urgency from restock framing.','Quick cuts of restocked bins, then the Sunset Fade reveal.','restock-montage,new-drop-reveal,text-overlay','Check the listing before it sells out','Restock montage that teases the new Sunset Fade colorway.')
) AS t(video_id, format_style, hook_effectiveness, hook_description, lane2_techniques, primary_cta, content_summary);

CREATE OR REPLACE TABLE orders AS
SELECT order_id, order_status, product_name, variation, quantity, sku_subtotal_after_discount,
       (CURRENT_DATE - day_offset)::timestamp AS created_time
FROM (VALUES
  -- Nebula — proven best-seller, spread across the window
  ('o01','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 12 oz',1,16.00,25),
  ('o02','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 12 oz',1,16.00,20),
  ('o03','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 12 oz',2,30.00,12),
  ('o04','Shipped',  'Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 12 oz',1,15.00, 7),
  ('o05','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 12 oz',1,16.00, 2),
  ('o06','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 16 oz',1,18.00,18),
  ('o07','Shipped',  'Galaxy Mug Buddy – 3D Printed Cup Companion','Nebula, 16 oz',1,18.00, 3),
  -- Pastel Sky — steady mid-tier
  ('o08','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Pastel Sky, 12 oz',1,15.00,15),
  ('o09','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Pastel Sky, 12 oz',1,15.00, 9),
  ('o10','Shipped',  'Galaxy Mug Buddy – 3D Printed Cup Companion','Pastel Sky, 12 oz',1,15.00, 5),
  ('o11','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Pastel Sky, 12 oz',1,15.00, 1),
  ('o12','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Pastel Sky, 16 oz',1,18.00, 6),
  -- Galaxy — mid
  ('o13','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Galaxy, 12 oz',1,15.00,10),
  ('o14','Shipped',  'Galaxy Mug Buddy – 3D Printed Cup Companion','Galaxy, 12 oz',1,15.00, 8),
  ('o15','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Galaxy, 12 oz',1,15.00, 4),
  ('o16','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Galaxy, 16 oz',1,18.00, 2),
  -- Sunset Fade — BRAND NEW rising star (only the last few days)
  ('o17','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Sunset Fade, 12 oz',1,16.00, 3),
  ('o18','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Sunset Fade, 12 oz',2,32.00, 2),
  ('o19','Shipped',  'Galaxy Mug Buddy – 3D Printed Cup Companion','Sunset Fade, 12 oz',1,16.00, 1),
  -- A couple of small new entrants
  ('o20','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Color Block, 12 oz',1,15.00, 2),
  ('o21','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Color Block, 12 oz',1,15.00, 1),
  ('o22','Completed','Galaxy Mug Buddy – 3D Printed Cup Companion','Cloud Nine, 12 oz',1,15.00, 1)
) AS t(order_id, order_status, product_name, variation, quantity, sku_subtotal_after_discount, day_offset);
