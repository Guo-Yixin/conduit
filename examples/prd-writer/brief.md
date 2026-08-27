# Brief: Flow 2 — New Product Line

Draft the PRD for the studio's second flow: creating a NEW Shopify product
(the studio v1 flow only adds variants to existing products — read
reference-prd.md first; do not duplicate its scope).

What Flow 2 must cover that v1 deliberately excluded: product descriptions,
pricing, collection assignment, product status (draft vs live — products DO
have draft state, unlike variants), and the initial variant set. Same
surfaces: Slack ingress, local VLM for naming/creative, one-card approval,
Shopify Admin API, refs append. Same constraints: local-only inference,
caption-first UX, fail-fast validation, named failures in-thread.

House PRD structure (see the studio PRD): §1 Context, §2 Problem, §3 Users &
use cases, §4 Goals w/ measurable metrics, §5 Scope in/out, §6 Requirements
(FR/NFR/edge cases), §8 Solution approach, §9 Technical considerations, §10
Risks & open questions + Resolved Decisions. (§7 deliberately absent.)
Mark genuinely open decisions as open — do not invent resolutions.
