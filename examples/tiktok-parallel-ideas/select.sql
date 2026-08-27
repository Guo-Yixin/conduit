-- select.sql — pick the batch of products to ideate on this run.
--
-- Ranks products by recent sales velocity and selects the top-5 and bottom-5,
-- emitting one row per chosen product as a JSON array to selected.json. The
-- `plan` station turns each row into a child lane.
--
-- Velocity here = units sold in the recent window vs. the prior window. Swap in
-- your own definition (revenue, GMV growth, etc.) — the flow doesn't care, the
-- selection policy lives entirely in this one query.
--
-- NOTE: points at the committed synthetic fixture (fixtures/fixture.duckdb,
-- mirrors tiktok-shoppable-ideas). Point it at real data to run for real.

COPY (
  WITH velocity AS (
    SELECT
      product_id        AS id,
      product_title     AS title,
      units_recent,
      units_prior,
      (units_recent - units_prior) AS velocity
    FROM product_sales
  ),
  ranked AS (
    -- `id ASC` is a deterministic tie-breaker: without it, products with equal
    -- velocity get an unspecified order, so the selected batch could vary across
    -- identical runs — which would diverge checkpoint binding stamps on replay
    -- and break the deterministic-substrate guarantee.
    SELECT *, row_number() OVER (ORDER BY velocity DESC, id ASC) AS top_rank,
              row_number() OVER (ORDER BY velocity ASC,  id ASC) AS bottom_rank
    FROM velocity
  )
  SELECT id, title,
         CASE WHEN top_rank <= 5 THEN 'top' ELSE 'bottom' END AS band
  FROM ranked
  WHERE top_rank <= 5 OR bottom_rank <= 5
  ORDER BY band, velocity DESC, id ASC
) TO 'selected.json' (FORMAT json, ARRAY true);
