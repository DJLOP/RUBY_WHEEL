/**
 * Canonical geography: the base revision a pending revision was built against.
 *
 * One editor draft and one software proposal may revise the same accepted row at once
 * (002's open-revision index). Without knowing which canonical revision each was made
 * from, accepting one and then the other lets the second silently replace the first's
 * newer constraints. `base_revision` records the target's revision when the draft or
 * proposal was created; accept refuses it when the target has moved on since.
 *
 * Additive only: one nullable column per entity table, no row rewritten. NULL means "not
 * a revision" (new drafts and proposals). A pending revision that predates this column is
 * also left NULL rather than guessed at — its base cannot be proven, so accept treats it
 * as stale and it must be recreated from current canon. Staleness is derived by comparing
 * `base_revision` with the target's `revision`; there is no stale lifecycle state.
 *
 * See docs/CANONICAL_GEOGRAPHY_PLAN.md §3.1 and §3.7.
 */

const TABLES = ['canonical_features', 'canonical_anchors', 'canonical_connections', 'geo_scopes'];

module.exports = {
  name: '003-canonical-base-revision',

  async up({ run }) {
    for (const table of TABLES) {
      await run(`ALTER TABLE ${table} ADD COLUMN base_revision INTEGER
                 CHECK (base_revision IS NULL OR base_revision >= 1)`);
    }
  },
};
