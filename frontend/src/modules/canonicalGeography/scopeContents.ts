/**
 * What a selected scope spatially contains, for the context pane and the scene overlay
 * (WP6 live-acceptance remediation).
 *
 * Pure: no React, Three.js, network or reference-layer imports.
 *
 * For an accepted scope the contents come from the WP3 generator-facing query bundle —
 * the same spatial truth generators get — so nothing here re-derives it. A draft scope
 * cannot be queried (the query reads accepted canon only), so its contents are a clearly
 * labelled preview from its draft boundary (or explicit members) using the same predicates
 * as the land selection.
 *
 * All of this is derived display. It never becomes, and never changes, explicit membership.
 */

import type { BBox, CanonicalFeature, CanonicalPolygon, CanonicalQueryBundle, GeoScope, Relation } from './types';
import { landInsideBoundary, selectableLand } from './landSelection';

export interface ContentRow {
  /** The canonical feature to highlight/inspect (for an anchor: its first part in the bundle, if any). */
  featureId: number | null;
  label: string;
  relation: Relation | 'unplaced' | 'internal' | 'crossing' | 'external_obligation' | null;
  /** Anchor parts, each inspectable. */
  parts?: { featureId: number; label: string }[];
}

export interface ScopeSpatial {
  /** 'query': the WP3 bundle of accepted canon; 'preview': a draft scope, computed locally. */
  source: 'query' | 'preview' | 'none';
  extent: CanonicalPolygon[];
  land: { inside: number[]; crossing: number[]; context: number[] };
  groups: { anchors: ContentRow[]; routes: ContentRow[]; water: ContentRow[]; protected: ContentRow[]; sites: ContentRow[]; connections: ContentRow[] };
  digest: string | null;
}

const EMPTY_GROUPS = (): ScopeSpatial['groups'] => ({ anchors: [], routes: [], water: [], protected: [], sites: [], connections: [] });

export const NO_SPATIAL: ScopeSpatial = { source: 'none', extent: [], land: { inside: [], crossing: [], context: [] }, groups: EMPTY_GROUPS(), digest: null };

const byId = (a: number, b: number) => a - b;

/** The query bundle's contents, grouped. Land relation 'boundary' means on or crossing the extent boundary. */
export function spatialFromBundle(bundle: CanonicalQueryBundle): ScopeSpatial {
  const land = bundle.land ?? [];
  const named = (f: { id: number; name: string | null; feature_class: string; kind: string | null }) =>
    `#${f.id} ${f.name || '(unnamed)'} · ${f.feature_class}${f.kind ? `/${f.kind}` : ''}`;
  const rows = <T extends { id: number; name: string | null; feature_class: string; kind: string | null; relation: Relation }>(list: T[] | undefined) =>
    (list ?? []).map(f => ({ featureId: f.id, label: named(f), relation: f.relation }));
  return {
    source: 'query',
    extent: bundle.scope.extent,
    land: {
      inside: land.filter(l => l.relation === 'inside').map(l => l.id).sort(byId),
      crossing: land.filter(l => l.relation === 'boundary').map(l => l.id).sort(byId),
      context: land.filter(l => l.relation === 'context').map(l => l.id).sort(byId),
    },
    groups: {
      anchors: (bundle.anchors ?? []).map(a => ({
        featureId: a.parts.find(p => p.relation !== 'outside')?.feature_id ?? null,
        label: `${a.name} (${a.anchor_key})${a.placed ? '' : ' · UNPLACED'}${a.must_exist ? ' · must-exist' : ''}`,
        relation: a.relation,
        parts: a.parts.filter(p => p.relation !== 'outside').map(p => ({ featureId: p.feature_id, label: `#${p.feature_id} ${p.part_role ?? 'part'} · ${p.feature_class}` })),
      })),
      routes: rows(bundle.routes),
      water: rows(bundle.water),
      protected: rows(bundle.protected),
      sites: rows(bundle.sites),
      connections: (bundle.connections ?? []).map(c => ({
        featureId: null,
        label: `#${c.id} ${c.name ?? ''} ${c.connection_kind ?? 'mode unspecified'} · ${c.constraint_strength} · ${c.from.ref_type} #${c.from.ref_id} → ${c.to.ref_type} #${c.to.ref_id}`,
        relation: c.tag,
      })),
    },
    digest: bundle.digest,
  };
}

const bboxOf = (poly: CanonicalPolygon): BBox => ({
  min_x: Math.min(...poly.outer.map(p => p.x)), min_z: Math.min(...poly.outer.map(p => p.z)),
  max_x: Math.max(...poly.outer.map(p => p.x)), max_z: Math.max(...poly.outer.map(p => p.z)),
});

/**
 * A draft scope's contents, locally: accepted land inside / crossing its boundary polygon
 * (draft or accepted), or, with no boundary, its explicit member islands as the extent.
 */
export function spatialPreview(scope: GeoScope, features: CanonicalFeature[]): ScopeSpatial {
  const boundary = scope.boundary_feature_id ? features.find(f => f.id === scope.boundary_feature_id) : null;
  if (boundary && boundary.geometry_type === 'polygon') {
    const poly = boundary.geometry as CanonicalPolygon;
    const { inside, straddling } = landInsideBoundary(selectableLand(features), poly, boundary.bbox ?? bboxOf(poly));
    return { ...NO_SPATIAL, source: 'preview', extent: [poly], land: { inside, crossing: straddling, context: [] }, groups: EMPTY_GROUPS() };
  }
  const members = selectableLand(features).filter(f => scope.members.includes(f.id));
  if (!members.length) return { ...NO_SPATIAL, source: 'preview' };
  return {
    ...NO_SPATIAL, source: 'preview', extent: members.map(f => f.geometry as CanonicalPolygon),
    land: { inside: members.map(f => f.id).sort(byId), crossing: [], context: [] }, groups: EMPTY_GROUPS(),
  };
}

/**
 * Region scopes (districts, subregions) whose boundary polygon holds or crosses a land
 * feature — derived from loaded geometry, for a feature's context card. Not membership.
 */
export function spatialScopesOf(land: CanonicalFeature, scopes: GeoScope[], features: CanonicalFeature[]):
  { scope: GeoScope; relation: 'inside' | 'crossing' }[] {
  const out: { scope: GeoScope; relation: 'inside' | 'crossing' }[] = [];
  for (const s of scopes) {
    if (s.revises_id !== null || s.lifecycle_state === 'retired' || !s.boundary_feature_id) continue;
    const b = features.find(f => f.id === s.boundary_feature_id);
    if (!b || b.geometry_type !== 'polygon') continue;
    const r = landInsideBoundary([land], b.geometry as CanonicalPolygon, b.bbox);
    if (r.inside.length) out.push({ scope: s, relation: 'inside' });
    else if (r.straddling.length) out.push({ scope: s, relation: 'crossing' });
  }
  return out;
}
