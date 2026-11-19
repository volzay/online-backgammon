# Quarter-aware long-bot experience

The previous experience context grouped positions by phase, head/outside/start
counts, opponent bearoff, trap risk and pip deficit. Different gates and towers
could share every bucket. The new descriptor additionally preserves each side's
exact count on each of the six physical points in all four player-relative
quarters, and both borne-off counts.

## Representation and application

- `quarterPositionProfile(state, color)` returns four quarter layouts, totals,
  occupied-point counts and maximum stacks. Both colours are measured on the
  same points in the player's direction, so contact geometry is retained.
- Ranked candidate telemetry contains before/after profiles. Its experience
  context ends in `|quarters:ql1:...`; the exact action also includes the
  resulting layout in `|after-quarters:ql1:...`. The original seven context
  fields retain their order. Colour rotation preserves relative identity.
- Legacy observational strategy/phase/global aliases retain geometry for new
  records. They cannot strip it and match a different arrangement. Legacy rows
  remain in their original namespace; missing geometry is never fabricated.
- Server causal credit remains exact-only, with the existing confidence,
  provenance and safety checks. The richer strings pass through server
  aggregation and compact room recovery without a database schema change.
- This is an applicability improvement. Exact four-quarter geometry identifies
  the entire board; it does **not** prove transfer to merely similar positions.
  No new tactical weights or claims of increased winning probability are added.

## Resources and compatibility

Search depth, node/candidate budgets, dice generation and dispatcher weights
are unchanged. Detailed layouts are omitted from hypothetical reply scoring;
they are recorded on candidate analysis and memory descriptors. No VPS jobs,
archive deletion, training, tariff change or automatic deployment is involved.

The generated implementation ID is new. Live RPC, cache and teacher guards
explicitly admit that exact ID; historical identities and cache tuples remain
unchanged. There is no historical learning alias. This preserves provenance:
old causal records cannot be relabelled as newly confirmed geometry evidence.

Before activation, preserve the currently served runtime and its lesson set.
Existing games must finish on their frozen runtime. Existing archives/lessons
remain stored under their original identity. Reusing an old game for new-policy
causal credit requires explicit re-review with regenerated descriptors and the
unchanged confirmation gates; do not remove archived identity checks or publish
an empty replacement as a migration. No archive re-review is launched by this
patch.

## Verification

`tests/long-bot-quarter-experience.test.js` covers exact arrangements and counts,
equal-total collisions, colour rotation, before/after transitions, JSON and
key-only recovery, causal action identity, scoped observational aliases, legacy
preservation, and a synthetic trusted-channel lesson changing an eligible native
choice. The synthetic lesson is a plumbing fixture, not playing-strength data.

Existing causal, publication, signed-round, cache and room-restoration tests
remain responsible for provenance, evidence thresholds and recovery limits.
