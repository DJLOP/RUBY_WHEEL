/**
 * The generator seam (plan §6.1): a query bundle → `CanonicalConstraints`.
 *
 * Pure TypeScript. It imports nothing from React, Three.js, the network or reference
 * layers — a test enforces that — so it runs wherever generation runs, today in the
 * browser, later perhaps on the server, against the same versioned bundle. It reads only
 * the bundle; raster evidence never reaches it.
 *
 * Land/water semantics are plan §4.2:
 *   - explicit water wins over land (a canal or basin cut into an island);
 *   - accepted land is land;
 *   - anywhere else inside a complete-coverage extent is water;
 *   - everything else is unknown — neither buildable nor water.
 *
 * Footprint checks sample the centre and four corners, exactly like the inherited
 * `footprintInWater`: a footprint straddling a feature narrower than itself can slip
 * through, which is acceptable for placement. Point and line anchor parts and hard routes
 * are tested exactly against the rectangle, because sampling would miss them.
 *
 * Nothing here is wired into `generateCity`; that bridge belongs to the pilot slice.
 */

import type {
  BBox, BundleConnection, BundleFeature, CanonicalPolygon, CanonicalQueryBundle, EntityRef, WorldXZ,
} from './types';

export type GroundClass = 'land' | 'water' | 'unknown';

/** A centred, axis-aligned footprint — the inherited `Obstacle` / building convention. */
export interface FootprintRect {
  x: number;
  z: number;
  width: number;
  depth: number;
}

/** Structurally the inherited `Obstacle`, so it can be handed straight to `SpatialGrid`. */
export type ObstacleRect = FootprintRect;

export type FootprintConflict =
  | 'off_land'
  | 'in_water'
  | 'unknown_ground'
  | 'protected'
  | 'anchor_part'
  | 'hard_route';

/** Reasons are always reported in this order, each at most once. */
export const FOOTPRINT_CONFLICT_ORDER: readonly FootprintConflict[] = [
  'off_land', 'in_water', 'unknown_ground', 'protected', 'anchor_part', 'hard_route',
];

export interface AnchorPartHit {
  anchor_id: number;
  feature_id: number;
  part_role: string | null;
}

export interface CanonicalConstraints {
  readonly bundle: CanonicalQueryBundle;
  readonly digest: string;
  /** Plan §4.2: 'water' beats 'land'; off-land is water only under complete coverage. */
  classifyPoint(x: number, z: number): GroundClass;
  /** Whether the point lies inside the requested extent (not merely its halo). */
  inExtent(x: number, z: number): boolean;
  isProtected(x: number, z: number): boolean;
  /** Anchor parts at the point; points and lines match within `tolerance` world units. */
  anchorPartsAt(x: number, z: number, tolerance?: number): AnchorPartHit[];
  footprintConflicts(rect: FootprintRect): FootprintConflict[];
  /** Connections this extent must honour across its edge: crossing and external obligations. */
  boundaryObligations(): BundleConnection[];
  isImmutable(ref: EntityRef): boolean;
  /** Hard anchor-site polygons and hard protected regions, as SpatialGrid-compatible rects. */
  obstacles(): ObstacleRect[];
}

// ── planar predicates (floating point, boundary inclusive) ───────────────────

const EPS = 1e-9;

function onSegment(px: number, pz: number, a: WorldXZ, b: WorldXZ): boolean {
  const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
  if (Math.abs(cross) > EPS * Math.max(1, Math.hypot(b.x - a.x, b.z - a.z))) return false;
  return px >= Math.min(a.x, b.x) - EPS && px <= Math.max(a.x, b.x) + EPS
    && pz >= Math.min(a.z, b.z) - EPS && pz <= Math.max(a.z, b.z) + EPS;
}

/** 'inside' | 'boundary' | 'outside' against one open ring. */
export function locateInRing(px: number, pz: number, ring: WorldXZ[]): 'inside' | 'boundary' | 'outside' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (onSegment(px, pz, a, b)) return 'boundary';
    if ((a.z > pz) !== (b.z > pz) && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/** Interior or boundary of the polygon; a hole's interior is outside. */
export function pointInCanonicalPolygon(px: number, pz: number, polygon: CanonicalPolygon): boolean {
  const outer = locateInRing(px, pz, polygon.outer);
  if (outer !== 'inside') return outer === 'boundary';
  for (const hole of polygon.holes ?? []) {
    if (locateInRing(px, pz, hole) === 'inside') return false;
  }
  return true;
}

function distanceToSegment(px: number, pz: number, a: WorldXZ, b: WorldXZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2));
  return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
}

/** Whether segment a-b meets the closed rectangle (Liang–Barsky clip). */
function segmentHitsRect(a: WorldXZ, b: WorldXZ, r: BBox): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const edges: [number, number][] = [[-dx, a.x - r.min_x], [dx, r.max_x - a.x], [-dz, a.z - r.min_z], [dz, r.max_z - a.z]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

const rectBox = (r: FootprintRect, grow = 0): BBox => ({
  min_x: r.x - r.width / 2 - grow, max_x: r.x + r.width / 2 + grow,
  min_z: r.z - r.depth / 2 - grow, max_z: r.z + r.depth / 2 + grow,
});

const boxHas = (b: BBox, x: number, z: number) => x >= b.min_x && x <= b.max_x && z >= b.min_z && z <= b.max_z;
const boxesMeet = (a: BBox, b: BBox) => a.min_x <= b.max_x && b.min_x <= a.max_x && a.min_z <= b.max_z && b.min_z <= a.max_z;

function polygonBox(p: CanonicalPolygon): BBox {
  const box = { min_x: Infinity, min_z: Infinity, max_x: -Infinity, max_z: -Infinity };
  for (const v of p.outer) {
    if (v.x < box.min_x) box.min_x = v.x;
    if (v.x > box.max_x) box.max_x = v.x;
    if (v.z < box.min_z) box.min_z = v.z;
    if (v.z > box.max_z) box.max_z = v.z;
  }
  return box;
}

// ── a small bucket index over bboxes, so point lookups stay cheap at city scale ──

class BucketIndex<T extends { bbox: BBox }> {
  private readonly buckets = new Map<string, T[]>();
  private readonly cell: number;

  constructor(items: T[], cell: number) {
    this.cell = cell;
    for (const it of items) {
      const [x0, x1, z0, z1] = [this.c(it.bbox.min_x), this.c(it.bbox.max_x), this.c(it.bbox.min_z), this.c(it.bbox.max_z)];
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = `${cx},${cz}`;
          const list = this.buckets.get(k);
          if (list) list.push(it); else this.buckets.set(k, [it]);
        }
      }
    }
  }

  private c(v: number): number { return Math.floor(v / this.cell); }

  at(x: number, z: number): T[] {
    return (this.buckets.get(`${this.c(x)},${this.c(z)}`) ?? []).filter(it => boxHas(it.bbox, x, z));
  }
}

interface IndexedPolygon {
  bbox: BBox;
  polygon: CanonicalPolygon;
}

const polygonsOf = (features: BundleFeature[] | undefined): IndexedPolygon[] =>
  (features ?? []).filter(f => f.geometry_type === 'polygon')
    .map(f => ({ bbox: f.bbox, polygon: f.geometry as CanonicalPolygon }));

const anyContains = (index: BucketIndex<IndexedPolygon>, x: number, z: number) =>
  index.at(x, z).some(p => pointInCanonicalPolygon(x, z, p.polygon));

// ── the adapter ──────────────────────────────────────────────────────────────

export function createCanonicalConstraints(bundle: CanonicalQueryBundle): CanonicalConstraints {
  const everything: BundleFeature[] = [
    ...(bundle.land ?? []), ...(bundle.water ?? []), ...(bundle.protected ?? []),
    ...(bundle.routes ?? []), ...(bundle.sites ?? []),
  ];

  // Cell size from the overall span, so a city bundle and an island bundle both bucket well.
  const span = everything.reduce((b, f) => ({
    min_x: Math.min(b.min_x, f.bbox.min_x), min_z: Math.min(b.min_z, f.bbox.min_z),
    max_x: Math.max(b.max_x, f.bbox.max_x), max_z: Math.max(b.max_z, f.bbox.max_z),
  }), { min_x: Infinity, min_z: Infinity, max_x: -Infinity, max_z: -Infinity });
  const cell = Number.isFinite(span.min_x) ? Math.max(25, Math.max(span.max_x - span.min_x, span.max_z - span.min_z) / 64) : 25;

  const land = new BucketIndex(polygonsOf(bundle.land), cell);
  const water = new BucketIndex(polygonsOf(bundle.water), cell);
  const protectedRegions = new BucketIndex(polygonsOf(bundle.protected), cell);
  const toIndexed = (p: CanonicalPolygon) => ({ bbox: polygonBox(p), polygon: p });
  const complement = bundle.water_complement.rule === 'complete'
    ? bundle.water_complement.extent.map(toIndexed) : [];
  const extent = bundle.scope.extent.map(toIndexed);

  const parts = everything.filter(f => f.anchor_id !== null);
  const sitePartPolygons = new BucketIndex(polygonsOf(parts.filter(f => f.feature_class === 'site')), cell);
  const sitePartsOther = parts.filter(f => f.feature_class === 'site' && f.geometry_type !== 'polygon');
  const hardRoutes = (bundle.routes ?? []).filter(r => r.constraint_strength === 'hard');

  const immutable = new Set(bundle.immutable.map(r => `${r.entity_type}:${r.id}`));

  const classifyPoint = (x: number, z: number): GroundClass => {
    if (anyContains(water, x, z)) return 'water';
    if (anyContains(land, x, z)) return 'land';
    if (complement.some(p => boxHas(p.bbox, x, z) && pointInCanonicalPolygon(x, z, p.polygon))) return 'water';
    return 'unknown';
  };

  const isProtected = (x: number, z: number) => anyContains(protectedRegions, x, z);

  const anchorPartsAt = (x: number, z: number, tolerance = 0): AnchorPartHit[] => parts
    .filter((f) => {
      if (!boxHas({ min_x: f.bbox.min_x - tolerance, max_x: f.bbox.max_x + tolerance, min_z: f.bbox.min_z - tolerance, max_z: f.bbox.max_z + tolerance }, x, z)) return false;
      if (f.geometry_type === 'polygon') return pointInCanonicalPolygon(x, z, f.geometry as CanonicalPolygon);
      if (f.geometry_type === 'point') {
        const p = f.geometry as WorldXZ;
        return Math.hypot(p.x - x, p.z - z) <= tolerance;
      }
      const line = f.geometry as WorldXZ[];
      return line.some((a, i) => i > 0 && distanceToSegment(x, z, line[i - 1], a) <= tolerance);
    })
    .map(f => ({ anchor_id: f.anchor_id as number, feature_id: f.id, part_role: f.part_role }));

  const footprintConflicts = (rect: FootprintRect): FootprintConflict[] => {
    const found = new Set<FootprintConflict>();
    const box = rectBox(rect);
    const samples: [number, number][] = [
      [rect.x, rect.z], [box.min_x, box.min_z], [box.max_x, box.min_z], [box.min_x, box.max_z], [box.max_x, box.max_z],
    ];
    for (const [x, z] of samples) {
      const ground = classifyPoint(x, z);
      if (ground !== 'land') found.add('off_land');
      if (ground === 'water') found.add('in_water');
      if (ground === 'unknown') found.add('unknown_ground');
      if (isProtected(x, z)) found.add('protected');
      if (anyContains(sitePartPolygons, x, z)) found.add('anchor_part');
    }
    for (const f of sitePartsOther) {
      if (!boxesMeet(f.bbox, box)) continue;
      if (f.geometry_type === 'point') {
        const p = f.geometry as WorldXZ;
        if (boxHas(box, p.x, p.z)) found.add('anchor_part');
      } else {
        const line = f.geometry as WorldXZ[];
        if (line.some((a, i) => i > 0 && segmentHitsRect(line[i - 1], a, box))) found.add('anchor_part');
      }
    }
    for (const r of hardRoutes) {
      const width = typeof r.attributes?.width_wu === 'number' ? (r.attributes.width_wu as number) : 0;
      const corridor = rectBox(rect, width / 2);
      if (!boxesMeet(r.bbox, corridor)) continue;
      if (r.geometry.some((a, i) => i > 0 && segmentHitsRect(r.geometry[i - 1], a, corridor))) {
        found.add('hard_route');
        break;
      }
    }
    return FOOTPRINT_CONFLICT_ORDER.filter(c => found.has(c));
  };

  const obstacles = (): ObstacleRect[] => [
    ...parts.filter(f => f.feature_class === 'site' && f.geometry_type === 'polygon' && f.constraint_strength === 'hard'),
    ...(bundle.protected ?? []).filter(f => f.constraint_strength === 'hard'),
  ].map(f => ({
    x: (f.bbox.min_x + f.bbox.max_x) / 2,
    z: (f.bbox.min_z + f.bbox.max_z) / 2,
    width: f.bbox.max_x - f.bbox.min_x,
    depth: f.bbox.max_z - f.bbox.min_z,
  }));

  return {
    bundle,
    digest: bundle.digest,
    classifyPoint,
    inExtent: (x, z) => extent.some(p => boxHas(p.bbox, x, z) && pointInCanonicalPolygon(x, z, p.polygon)),
    isProtected,
    anchorPartsAt,
    footprintConflicts,
    boundaryObligations: () => (bundle.connections ?? []).filter(c => c.tag !== 'internal'),
    isImmutable: (ref) => immutable.has(`${ref.entity_type}:${ref.id}`),
    obstacles,
  };
}
