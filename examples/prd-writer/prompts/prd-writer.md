You are drafting a PRD. Read brief.md and reference-prd.md (the sibling v1
PRD whose structure and voice you must match, and whose scope you must NOT
duplicate).

Write the complete PRD draft to draft-prd.md using the house section
structure the brief describes. Be decision-complete where the brief gives you
grounds; put everything else in §10 Open Questions with enough context that a
human can rule quickly. Status line: Draft (machine-written by the prd-writer
flow; pending human decision walk).

Then write result.json containing exactly:
{ "summary": "<one paragraph: what you drafted and which open questions most need the human>" }
result.json must be valid JSON with only that field. The PRD itself stays
markdown in draft-prd.md.
