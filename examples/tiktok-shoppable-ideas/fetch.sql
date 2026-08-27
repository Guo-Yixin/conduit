-- fetch.sql — dogfood "fetch_context" station for the tiktok-shoppable-ideas flow.
--
-- Reads params from request.json (seeded by `conduit run --input`) and writes a single
-- context.json that the `ideate` prompt template is rendered against. The context gives the
-- model everything it needs to suggest a video AND which colorway/variant to feature.
--
-- Run (the deterministic station's command):
--   duckdb -readonly <path/to/arcane.duckdb> -f fetch.sql
-- with cwd = project_root (request.json present; context.json written there). Every argument
-- is metacharacter-free, so it passes the Law-lite allowlist with no shell wrapper.
--
-- context.json shape:
--   { product_id,
--     clock{ today, last_video_date, days_since_last_video },   -- run date + recency
--     display_name,
--     ad_performance{spend,orders,revenue,roi,cost_per_order,impressions,clicks},
--     top_hooks[{gmv,views,format_style,hook_effectiveness,hook,techniques,cta}],
--     recent_videos[{posted,description,format_style,content_summary,views,gmv}],  -- DON'T repeat these
--     sales{ name_pattern, as_of, recent_days, total{orders,units,revenue},
--            best_colorways[{colorway,units,revenue}],          -- proven sellers to feature
--            rising_stars[{variant,colorway,size,first_sold,days_live,units_recent,units_prior,units_total}] } }
--                                                                -- new/accelerating variants to feature
--
-- Data quirks handled (see ArcaneLayer .../arcane/queries/arcane-duckdb-queries.md):
--   * No active/inactive flag — campaign `status` is stale/creative-level. Active campaigns
--     are filtered by a maintained name list passed in request.json.
--   * product_id (TikTok ads) has NO clean join key to orders (TikTok Shop sku_id space), so
--     sales are matched by a name pattern (`sales_name_like`) supplied with the product_id.
--   * `videos` has multiple rows per video_id — deduped with GROUP BY video_id.
--   * Velocity windows are anchored to the product's OWN latest order date (`as_of`), so the
--     "rising" signal is robust to overall data lag.

COPY (
  WITH
  p AS (SELECT * FROM read_json_auto('request.json')),
  matched AS (
    SELECT variation,
           trim(split_part(variation, ',', 1))                AS colorway,
           nullif(trim(split_part(variation, ',', 2)), '')    AS size,
           quantity                                           AS q,
           sku_subtotal_after_discount                        AS rev,
           created_time::date                                 AS d,
           order_id
    FROM orders
    WHERE order_status IN ('Completed', 'Shipped', 'To ship')
      AND product_name ILIKE (SELECT sales_name_like FROM p)
      AND created_time >= CURRENT_DATE - (SELECT lookback_days FROM p) * INTERVAL '1 day'
  ),
  anch AS (SELECT max(d) AS maxd FROM matched),
  vstats AS (
    SELECT variation,
           any_value(colorway) AS colorway,
           any_value(size)     AS size,
           sum(q)              AS units,
           round(sum(rev), 2)  AS revenue,
           min(d)              AS first_sold,
           date_diff('day', min(d), (SELECT maxd FROM anch)) + 1 AS days_live,
           coalesce(sum(q) FILTER (WHERE d > (SELECT maxd FROM anch) - (SELECT recent_days::INTEGER FROM p)), 0)       AS units_recent,
           coalesce(sum(q) FILTER (WHERE d <= (SELECT maxd FROM anch) - (SELECT recent_days::INTEGER FROM p)
                                     AND d  > (SELECT maxd FROM anch) - 2 * (SELECT recent_days::INTEGER FROM p)), 0)  AS units_prior
    FROM matched GROUP BY variation
  ),
  -- Recent videos already made for this product (anti-repeat signal for `ideate`).
  pv AS (
    SELECT v.video_id,
           any_value(v.posted_at)       AS posted,
           any_value(v.description)     AS description,
           max(v.views)                 AS views,
           max(v.gmv)                   AS gmv,
           any_value(va.content_summary) AS content_summary,
           any_value(va.format_style)    AS format_style
    FROM (SELECT DISTINCT video_id FROM campaigns
           WHERE product_id = (SELECT product_id FROM p) AND video_id <> '-') c
    JOIN videos v          ON v.video_id  = c.video_id
    LEFT JOIN video_analysis va ON va.video_id = c.video_id
    WHERE coalesce(v.description, '') <> ''
    GROUP BY v.video_id
  ),
  pv_anchor AS (SELECT max(posted) AS maxp FROM pv),
  -- Latest video of any kind for this product (no description filter) — for "days since".
  vid_anchor AS (
    SELECT max(v.posted_at)::date AS last_video
    FROM (SELECT DISTINCT video_id FROM campaigns
           WHERE product_id = (SELECT product_id FROM p) AND video_id <> '-') c
    JOIN videos v ON v.video_id = c.video_id
  )
  SELECT
    (SELECT product_id FROM p) AS product_id,

    -- Optional free-text launch brief carried through from request.json so the
    -- ideate prompt can feature a net-new drop (a product not yet in the sales
    -- data). Backward-compatible: read via json_extract from the raw file so a
    -- request.json WITHOUT the field does not error (unlike `SELECT col FROM p`),
    -- defaulting to '' — the ideate prompt ignores an empty brief.
    (SELECT COALESCE(json_extract_string(content, '$.creative_brief'), '')
       FROM read_text('request.json')) AS creative_brief,

    -- Run clock: today's date + how stale the last video is, so the prompt can reason
    -- "it's been N days since your last <product> video."
    {
      'today':                 CURRENT_DATE,
      'last_video_date':       (SELECT last_video FROM vid_anchor),
      'days_since_last_video': date_diff('day', (SELECT last_video FROM vid_anchor), CURRENT_DATE)
    } AS clock,

    -- Display label: most-recent video title under this product_id (listing names drift).
    (SELECT v.product
       FROM campaigns c JOIN videos v ON c.video_id = v.video_id
      WHERE c.product_id = (SELECT product_id FROM p) AND v.product NOT IN ('-', 'N/A', '')
      ORDER BY c.posted_at DESC NULLS LAST LIMIT 1) AS display_name,

    -- Ad performance across the active campaigns for this product_id.
    (SELECT {
       'spend':          ROUND(SUM(cost), 2),
       'orders':         SUM(sku_orders),
       'revenue':        ROUND(SUM(gross_revenue), 2),
       'roi':            ROUND(SUM(gross_revenue) / NULLIF(SUM(cost), 0), 2),
       'cost_per_order': ROUND(SUM(cost) / NULLIF(SUM(sku_orders), 0), 2),
       'impressions':    SUM(ad_impressions),
       'clicks':         SUM(ad_clicks)
     }
       FROM campaigns
      WHERE product_id = (SELECT product_id FROM p)
        AND campaign_name IN (SELECT unnest(active_campaigns) FROM p)) AS ad_performance,

    -- Top-performing hooks/techniques: this product's campaign videos with analysis, by GMV.
    (SELECT list({
       'gmv': gmv, 'views': views, 'format_style': format_style,
       'hook_effectiveness': hook_effectiveness, 'hook': hook_description,
       'techniques': lane2_techniques, 'cta': primary_cta
     } ORDER BY gmv DESC NULLS LAST)
       FROM (
         SELECT va.video_id, MAX(v.gmv) AS gmv, MAX(v.views) AS views,
                ANY_VALUE(va.format_style) AS format_style, ANY_VALUE(va.hook_effectiveness) AS hook_effectiveness,
                ANY_VALUE(va.hook_description) AS hook_description, ANY_VALUE(va.lane2_techniques) AS lane2_techniques,
                ANY_VALUE(va.primary_cta) AS primary_cta
           FROM (SELECT DISTINCT video_id FROM campaigns
                  WHERE product_id = (SELECT product_id FROM p) AND video_id <> '-') c
           JOIN videos v          ON v.video_id  = c.video_id
           JOIN video_analysis va ON va.video_id = c.video_id
          GROUP BY va.video_id ORDER BY gmv DESC NULLS LAST LIMIT 6
       )) AS top_hooks,

    -- Videos already posted for this product within the recent window — so `ideate`
    -- does NOT repeat an angle that's already been filmed. Anchored to the product's
    -- own latest video date (lag-robust), bounded by recent_video_days.
    (SELECT list({'posted': posted, 'description': left(description, 240),
                  'format_style': format_style, 'content_summary': left(content_summary, 160),
                  'views': views, 'gmv': gmv} ORDER BY posted DESC NULLS LAST)
       FROM (SELECT * FROM pv
              WHERE posted >= (SELECT maxp FROM pv_anchor)::date - (SELECT recent_video_days::INTEGER FROM p)
              ORDER BY posted DESC NULLS LAST LIMIT 12)) AS recent_videos,

    -- Variant intelligence: what to feature. Proven best colorways + currently-rising variants.
    {
      'name_pattern': (SELECT sales_name_like FROM p),
      'as_of':        (SELECT maxd FROM anch),
      'recent_days':  (SELECT recent_days::INTEGER FROM p),
      'total': (SELECT {'orders': count(DISTINCT order_id), 'units': sum(q), 'revenue': round(sum(rev), 2)} FROM matched),

      -- Best-selling colorways (sizes rolled up) — the proven thing to feature.
      'best_colorways': (SELECT list({'colorway': colorway, 'units': units, 'revenue': revenue} ORDER BY units DESC, revenue DESC)
                           FROM (SELECT colorway, sum(units) AS units, round(sum(revenue), 2) AS revenue
                                   FROM vstats GROUP BY colorway ORDER BY units DESC, revenue DESC LIMIT 8)),

      -- Rising stars — variants with the most units in the recent window, newest first.
      'rising_stars': (SELECT list({'variant': variation, 'colorway': colorway, 'size': size,
                                    'first_sold': first_sold, 'days_live': days_live,
                                    'units_recent': units_recent, 'units_prior': units_prior, 'units_total': units}
                                   ORDER BY units_recent DESC, first_sold DESC)
                         FROM (SELECT * FROM vstats WHERE units_recent > 0
                                ORDER BY units_recent DESC, first_sold DESC LIMIT 6))
    } AS sales
) TO 'context.json' (FORMAT JSON, ARRAY false);
