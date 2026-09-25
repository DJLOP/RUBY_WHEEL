/**
 * Pure WP6 helpers: scope hierarchy and explicit membership, anchor forms and actions,
 * connection forms and endpoint choices.
 */

import { describe, it, expect } from 'vitest';
import {
  ancestryOf, childrenOf, emptyScopeForm, landMembership, membersAfter, membershipChange, parentOptions, sameKindHolders, scopeBody,
  scopeFormIssues, scopeRoots, slugify,
} from '../scopes';
import { anchorActions, anchorBody, anchorFormIssues, emptyAnchorForm, isPlaced, partsOf } from '../anchors';
import {
  connectionAcceptHints, connectionBody, connectionFormIssues, emptyConnectionForm, endpointOptions, viaOptions,
} from '../connections';
import { CITY, anchorRec, land, routeFeature, scopeRec } from './wp6Fixtures';

const district = scopeRec(2, 'district', 1, { members: [10, 11, 12] });
const group = scopeRec(3, 'island_group', 2, { members: [10, 11] });
const sub = scopeRec(4, 'subregion', 3, { members: [10] });
const draftDistrict = scopeRec(5, 'district', 1, { lifecycle_state: 'draft', members: [13] });
const scopes = [CITY, district, group, sub, draftDistrict];

describe('scope hierarchy', () => {
  it('shows children, ancestry and roots', () => {
    expect(childrenOf(scopes, 1).map(s => s.id)).toEqual([2, 5]);
    expect(childrenOf(scopes, 2).map(s => s.id)).toEqual([3]);
    expect(ancestryOf(scopes, sub).map(s => s.id)).toEqual([1, 2, 3]);
    expect(scopeRoots(scopes).map(s => s.id)).toEqual([1]);
  });

  it('never lists a draft revision as a child', () => {
    const rev = scopeRec(9, 'district', 1, { lifecycle_state: 'draft', revises_id: 2 });
    expect(childrenOf([...scopes, rev], 1).map(s => s.id)).toEqual([2, 5]);
  });

  it('offers parents of strictly lower rank only, accepted first', () => {
    expect(parentOptions(scopes, 'district', null).map(s => s.id)).toEqual([1]);
    expect(parentOptions(scopes, 'island_group', null).map(s => s.id)).toEqual([1, 2, 5]);
    expect(parentOptions(scopes, 'subregion', 4).map(s => s.id)).toEqual([1, 2, 3, 5]);
  });
});

describe('explicit membership', () => {
  it('reports each island’s district, island group, chain and pending drafts', () => {
    const m = landMembership(scopes, 10);
    expect(m.byKind.district?.id).toBe(2);
    expect(m.byKind.island_group?.id).toBe(3);
    expect(m.chain.map(s => s.id)).toEqual([1, 2, 3, 4]);
    expect(landMembership(scopes, 13)).toMatchObject({ accepted: [], pending: [draftDistrict] });
  });

  it('lets a district island stay outside every island group', () => {
    const m = landMembership(scopes, 12);
    expect(m.byKind.district?.id).toBe(2);
    expect(m.byKind.island_group).toBeUndefined();
    expect(m.chain.map(s => s.id)).toEqual([1, 2]);
  });

  it('computes additions/removals and flags islands another same-kind scope already holds (informational)', () => {
    expect(membersAfter([3, 1], [2, 3], [1])).toEqual([2, 3]);
    expect(membershipChange([1, 2], [2, 3])).toEqual({ added: [3], removed: [1] });
    const other = scopeRec(6, 'district', 1);
    expect(sameKindHolders(scopes, other, [12, 99]).map(h => [h.featureId, h.holder.id])).toEqual([[12, 2]]);
    // A revision of the holder itself is not a clash.
    expect(sameKindHolders(scopes, scopeRec(7, 'district', 1, { revises_id: 2 }), [12])).toEqual([]);
  });
});

describe('scope form', () => {
  it('requires key, name and a parent, and carries no planning fields', () => {
    expect(scopeFormIssues(emptyScopeForm('district'))).toEqual(expect.arrayContaining([
      expect.stringMatching(/key/), 'name is required', 'a district needs a parent scope']));
    const body = scopeBody({ ...emptyScopeForm('island_group', 2), scope_key: 'north-chain', name: ' North Chain ' }, [10, 11]);
    expect(body).toEqual({
      scope_key: 'north-chain', name: 'North Chain', scope_kind: 'island_group', parent_scope_id: 2, boundary_feature_id: null,
      land_coverage: 'partial', description: null, notes: null, members: [10, 11],
    });
    for (const k of ['culture', 'wealth', 'crop_mix', 'generation_profile', 'building_budget', 'density']) expect(body).not.toHaveProperty(k);
    expect(scopeBody(emptyScopeForm())).not.toHaveProperty('members');
    expect(slugify('Arena District!')).toBe('arena-district');
  });
});

describe('anchors', () => {
  it('never offers replaceable for a must-exist anchor', () => {
    expect(anchorActions(anchorRec(1, { must_exist: true })).replacement).toEqual({ enabled: false, reason: 'a must-exist anchor can never be replaceable' });
    expect(anchorActions(anchorRec(1, { must_exist: false })).replacement.enabled).toBe(true);
  });

  it('derives placement from accepted parts only', () => {
    const features = [land(1, 0, 0, 10, { feature_class: 'site', anchor_id: 7, part_role: 'footprint', lifecycle_state: 'draft' })];
    expect(isPlaced(features, 7)).toBe(false);
    expect(isPlaced([{ ...features[0], lifecycle_state: 'accepted' }], 7)).toBe(true);
    expect(partsOf(features, 7).map(f => f.id)).toEqual([1]);
  });

  it('builds a draft body with no lifecycle/lock/replacement fields', () => {
    expect(anchorFormIssues(emptyAnchorForm())).toHaveLength(2);
    const body = anchorBody({ ...emptyAnchorForm(), anchor_key: 'arena-test', name: 'Arena', required_scope_id: 3 });
    expect(body).toMatchObject({ anchor_key: 'arena-test', constraint_strength: 'hard', must_exist: true, required_scope_id: 3 });
    for (const k of ['lifecycle_state', 'is_locked', 'replacement_state', 'revision']) expect(body).not.toHaveProperty(k);
  });
});

describe('connections', () => {
  const features = [land(1, 0), land(2, 20), routeFeature(3), routeFeature(4, { lifecycle_state: 'draft' })];

  it('lists endpoints by type (accepted first) and routes for via', () => {
    const opts = endpointOptions({ features, anchors: [anchorRec(8)], scopes });
    expect(opts.feature.map(o => o.id)).toEqual([1, 2, 3, 4]);
    expect(opts.feature[0].label).toMatch(/island/);
    expect(opts.anchor.map(o => o.id)).toEqual([8]);
    expect(viaOptions(features).map(o => [o.id, o.accepted])).toEqual([[3, true], [4, false]]);
  });

  it('requires two distinct endpoints; a soft connection needs no route', () => {
    expect(connectionFormIssues(emptyConnectionForm())).toHaveLength(2);
    const soft = { ...emptyConnectionForm(), from_ref_id: 1 as const, to_ref_id: 2 as const };
    expect(connectionFormIssues(soft)).toEqual([]);
    expect(connectionAcceptHints(soft, features)).toEqual([]);
    expect(connectionFormIssues({ ...soft, to_ref_id: 1 })).toEqual(['a connection must join two different entities']);
    expect(connectionBody(soft)).toMatchObject({ connection_kind: null, constraint_strength: 'soft', via_feature_id: null });
  });

  it('says up front that hard needs an accepted via route', () => {
    const hard = { ...emptyConnectionForm(), from_ref_id: 1 as const, to_ref_id: 2 as const, constraint_strength: 'hard' as const };
    expect(connectionAcceptHints(hard, features)[0]).toMatch(/requires an accepted route as VIA/);
    expect(connectionAcceptHints({ ...hard, via_feature_id: 4 }, features)[0]).toMatch(/draft; accept it/);
    expect(connectionAcceptHints({ ...hard, via_feature_id: 3 }, features)).toEqual([]);
  });
});
