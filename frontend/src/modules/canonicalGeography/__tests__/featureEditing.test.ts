/**
 * Which lifecycle controls a feature offers, and what a saved draft sends (plan §3.7, §7.2).
 * The server enforces all of this independently; these pin that the UI never offers a
 * shortcut around it.
 */

import { describe, it, expect } from 'vitest';
import { describeIssue, draftBody, emptyForm, featureActions, formFromFeature, formIssues, geometryMetrics } from '../featureEditing';
import type { CanonicalFeature } from '../types';

const feature = (over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  id: 1, entity_type: 'feature', name: 'Isle', description: null, notes: null,
  feature_class: 'land', kind: null, geometry_type: 'polygon',
  geometry: { outer: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], holes: [] },
  construction: null, attributes: null, bbox: { min_x: 0, min_z: 0, max_x: 10, max_z: 10 },
  anchor_id: null, part_role: null, constraint_strength: 'hard',
  lifecycle_state: 'accepted', provenance: 'authored', replacement_state: 'non_replaceable', is_locked: false,
  revision: 1, draft_version: 1, revises_id: null, base_revision: null, evidence: null, proposal: null,
  ...over,
});

const enabled = (a: ReturnType<typeof featureActions>) =>
  Object.entries(a).filter(([, v]) => v.enabled).map(([k]) => k).sort();

describe('featureActions', () => {
  it('drafts and proposals: edit, accept, delete — nothing canonical', () => {
    const expected = ['accept', 'deleteDraft', 'editGeometry', 'editProperties'];
    expect(enabled(featureActions(feature({ lifecycle_state: 'draft', revision: 0 })))).toEqual(expected);
    expect(enabled(featureActions(feature({ lifecycle_state: 'proposed', provenance: 'generated' })))).toEqual(expected);
  });

  it('accepted and unlocked: revise, descriptive edit, retire, lock, replacement, draft from history', () => {
    expect(enabled(featureActions(feature()))).toEqual(
      ['draftFromHistory', 'editDescriptive', 'lock', 'replacement', 'retire', 'revise']);
  });

  it('accepted and locked: unlock only — revise, retire, replacement and edits are disabled with a reason', () => {
    const a = featureActions(feature({ is_locked: true }));
    expect(enabled(a)).toEqual(['unlock']);
    for (const k of ['revise', 'retire', 'replacement', 'editDescriptive', 'draftFromHistory'] as const) {
      expect(a[k].reason).toMatch(/locked/);
    }
  });

  it('retired: restore only', () => {
    expect(enabled(featureActions(feature({ lifecycle_state: 'retired' })))).toEqual(['restore']);
  });

  it('points at an existing open revision rather than creating a second', () => {
    const a = featureActions(feature(), 42);
    expect(a.revise.enabled).toBe(false);
    expect(a.revise.reason).toMatch(/#42/);
    expect(a.draftFromHistory.enabled).toBe(false);
  });

  it('never offers accepted geometry edits in place', () => {
    expect(featureActions(feature()).editGeometry).toEqual({ enabled: false, reason: expect.stringMatching(/Revise/) });
  });
});

describe('draftBody', () => {
  it('sends only draft fields: no lifecycle, lock, replacement, revision or proposal', () => {
    const body = draftBody({ ...emptyForm('water'), kind: 'basin', navigable: 'yes', name: '  Basin ' },
      { outer: [], holes: [] }, null, null);
    expect(body).toEqual({
      feature_class: 'water', geometry_type: 'polygon', kind: 'basin', constraint_strength: 'hard',
      name: 'Basin', description: null, notes: null, geometry: { outer: [], holes: [] }, construction: null,
      attributes: { navigable: 'yes' }, evidence: null,
    });
    for (const k of ['lifecycle_state', 'is_locked', 'replacement_state', 'revision', 'provenance', 'proposal']) expect(body).not.toHaveProperty(k);
  });

  it('leaves saved evidence alone when none is given, and omits unspecified attributes', () => {
    const body = draftBody(emptyForm('route'), [], null, undefined);
    expect(body).not.toHaveProperty('evidence');
    expect(body.attributes).toBeNull();
  });

  it('round-trips a feature into the form', () => {
    const f = feature({ feature_class: 'route', geometry_type: 'linestring', kind: 'bridge', attributes: { width_wu: 4 } });
    expect(formFromFeature(f)).toMatchObject({ feature_class: 'route', kind: 'bridge', width_wu: '4', name: 'Isle' });
  });
});

describe('formIssues', () => {
  it('flags class/geometry mismatch, foreign kinds and bad widths', () => {
    expect(formIssues({ ...emptyForm('land'), geometry_type: 'point' })[0]).toMatch(/cannot have point/);
    expect(formIssues({ ...emptyForm('land'), kind: 'basin' })[0]).toMatch(/not a land kind/);
    expect(formIssues({ ...emptyForm('route'), width_wu: '-3' })[0]).toMatch(/positive/);
    expect(formIssues(emptyForm('site'))).toEqual([]);
  });
});

describe('metrics and messages', () => {
  it('counts vertices and measures geometry', () => {
    expect(geometryMetrics('polygon', feature().geometry)).toEqual({ vertexCount: 4, areaWu2: 100, lengthWu: 40 });
    expect(geometryMetrics('linestring', [{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 0, z: 0 }]).vertexCount).toBe(2);
  });

  it('words server violations and dependents', () => {
    expect(describeIssue({ code: 'land_contact', message: 'overlaps land #3' })).toBe('overlaps land #3');
    expect(describeIssue({ entity_type: 'scope', id: 4, relation: 'member' })).toBe('scope #4 (member)');
  });
});
