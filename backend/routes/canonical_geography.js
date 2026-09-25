const express = require('express');
const { authenticate, requireWorldEditor } = require('../middleware/auth');
const { createStore } = require('../canonicalGeography/store');
const { CanonicalError } = require('../canonicalGeography/errors');

/**
 * Canonical geography: lifecycle and protection (plan §5.1–§5.2, WP2), and the
 * generator-facing query (plan §5.3, WP3).
 *
 * The rules live in `canonicalGeography/store.js`; this file is authorization, HTTP shape
 * and the realtime nudge. Accepted canon is a public read, like the rest of the shared
 * world scene. Everything else — drafts, proposals, retired rows, history, and every
 * mutation — is the world editor's alone, enforced here rather than by hiding a button.
 *
 * Every successful mutation emits exactly one `dataUpdated`; a rejected one emits nothing.
 *
 * Canonical transactions run on their own SQLite connection to the same database file
 * (see canonicalGeography/connection.js), never on `db`, which the inherited routes share.
 */
module.exports = (db, io, { emitUpdate }) => {
  const router = express.Router();
  const store = createStore(db);
  router.canonicalStore = store;
  const editor = [authenticate, requireWorldEditor];

  const fail = (res, err) => {
    if (err instanceof CanonicalError) {
      return res.status(err.status).json({ error: err.message, ...err.details });
    }
    // Validation is meant to catch every constraint first; a SQL constraint reaching here
    // is still a refusal of the request, not a server fault.
    if (err && err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: `Refused by a database constraint: ${err.message}` });
    }
    return res.status(500).json({ error: err && err.message ? err.message : 'Unexpected error' });
  };

  /** Run the world-editor check inline; true when it passed, false when it already answered. */
  const passesEditor = (req, res) => {
    let ok = false;
    authenticate(req, res, () => requireWorldEditor(req, res, () => { ok = true; }));
    return ok;
  };

  /**
   * A mutation: one emit on success, none on failure. The payload flag tells clients this
   * broadcast changed canonical geography, so they refetch it only then — at city scale the
   * canonical set is megabytes, and inherited `dataUpdated` broadcasts are frequent and
   * never change it.
   */
  const mutation = (status, handler) => async (req, res) => {
    try {
      const result = await handler(req);
      emitUpdate({ canonicalGeography: true });
      res.status(status).json(result);
    } catch (err) { fail(res, err); }
  };

  // ── software proposals (before /:entity so "proposals" is never read as an entity) ──

  router.post('/proposals', ...editor, mutation(201, (req) => store.createProposal(req.body)));

  // ── generator-facing query (before /:entity so "query" is never read as an entity) ──

  // Public, like accepted canon itself, and read-only: it never emits. Only accepted rows
  // can reach the bundle (plan §5.3).
  router.post('/query', async (req, res) => {
    try {
      res.json(await store.query(req.body));
    } catch (err) { fail(res, err); }
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  // The must-exist anchor checklist: accepted anchors with derived placed/unplaced status.
  // Public like accepted canon, and registered before /:entity/:id so "register" is never an id.
  router.get('/anchors/register', async (req, res) => {
    try {
      res.json(await store.anchorRegister());
    } catch (err) { fail(res, err); }
  });

  // Accepted canon is public. Any other lifecycle state is the world editor's working set.
  router.get('/:entity', async (req, res) => {
    try {
      const states = store.parseStates(req.query.states);
      if (states.some(s => s !== 'accepted') && !passesEditor(req, res)) return;
      res.json(await store.list(req.params.entity, states));
    } catch (err) { fail(res, err); }
  });

  router.get('/:entity/:id', async (req, res) => {
    try {
      const rec = await store.get(req.params.entity, req.params.id);
      if (rec.lifecycle_state !== 'accepted' && !passesEditor(req, res)) return;
      res.json(rec);
    } catch (err) { fail(res, err); }
  });

  router.get('/:entity/:id/revisions', ...editor, async (req, res) => {
    try {
      res.json(await store.history(req.params.entity, req.params.id));
    } catch (err) { fail(res, err); }
  });

  // ── mutations ──────────────────────────────────────────────────────────────

  router.post('/:entity', ...editor,
    mutation(201, (req) => store.createDraft(req.params.entity, req.body)));

  router.patch('/:entity/:id', ...editor,
    mutation(200, (req) => store.patch(req.params.entity, req.params.id, req.body)));

  router.delete('/:entity/:id', ...editor,
    mutation(200, (req) => store.deleteDraft(req.params.entity, req.params.id)));

  router.post('/:entity/:id/revise', ...editor,
    mutation(201, (req) => store.revise(req.params.entity, req.params.id)));

  router.post('/:entity/:id/accept', ...editor,
    mutation(200, (req) => store.accept(req.params.entity, req.params.id, req.body)));

  router.post('/:entity/:id/retire', ...editor,
    mutation(200, (req) => store.retire(req.params.entity, req.params.id)));

  router.post('/:entity/:id/restore', ...editor,
    mutation(200, (req) => store.restore(req.params.entity, req.params.id)));

  router.patch('/:entity/:id/lock', ...editor,
    mutation(200, (req) => store.setLock(req.params.entity, req.params.id, req.body)));

  router.patch('/:entity/:id/replacement', ...editor,
    mutation(200, (req) => store.setReplacement(req.params.entity, req.params.id, req.body)));

  router.post('/:entity/:id/revisions/:rev/draft', ...editor,
    mutation(201, (req) => store.draftFromHistory(req.params.entity, req.params.id, req.params.rev)));

  return router;
};
