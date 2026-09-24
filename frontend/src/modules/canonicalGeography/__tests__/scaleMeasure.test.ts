/**
 * WP3 synthetic-scale measurement, client side (plan §10). Skipped in the normal suite.
 *
 * Run after the backend measurement has written its bundles:
 *
 *   node backend/scripts/measure-canonical-scale.js <dir>
 *   CANONICAL_SCALE_DIR=<dir> npx vitest run src/modules/canonicalGeography/__tests__/scaleMeasure.test.ts
 *
 * Times building `CanonicalConstraints` from the 500-island city bundle and using it the
 * way a generator would (point classification, footprint checks), plus render preparation:
 * the overlay's own `buildOverlayGeometry` — every feature triangulated or outlined into
 * merged buffers per class and state. Results are written to <dir>/frontend-measure.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createCanonicalConstraints } from '../constraints';
import type { CanonicalQueryBundle } from '../types';
import { buildOverlayGeometry } from '../overlay';

const DIR = process.env.CANONICAL_SCALE_DIR;
const ms = (start: number) => +(performance.now() - start).toFixed(1);

describe.skipIf(!DIR || !existsSync(join(DIR ?? '', 'city.json')))('canonical scale measurement (client)', () => {
  it('measures adapter and render-preparation cost on the synthetic city', () => {
    const results: Record<string, unknown> = {};
    for (const name of ['city', 'island']) {
      let t = performance.now();
      const bundle: CanonicalQueryBundle = JSON.parse(readFileSync(join(DIR!, `${name}.json`), 'utf8'));
      const parseMs = ms(t);

      t = performance.now();
      const c = createCanonicalConstraints(bundle);
      const buildMs = ms(t);

      const span = bundle.scope.extent[0].outer.reduce((b, p) => ({
        min_x: Math.min(b.min_x, p.x), max_x: Math.max(b.max_x, p.x), min_z: Math.min(b.min_z, p.z), max_z: Math.max(b.max_z, p.z),
      }), { min_x: Infinity, max_x: -Infinity, min_z: Infinity, max_z: -Infinity });
      let seed = 42;
      const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const POINTS = 100_000;
      t = performance.now();
      const tally = { land: 0, water: 0, unknown: 0 };
      for (let k = 0; k < POINTS; k++) {
        tally[c.classifyPoint(span.min_x + rand() * (span.max_x - span.min_x), span.min_z + rand() * (span.max_z - span.min_z))]++;
      }
      const classifyMs = ms(t);

      const FOOTPRINTS = 10_000;
      t = performance.now();
      let conflicted = 0;
      for (let k = 0; k < FOOTPRINTS; k++) {
        const r = c.footprintConflicts({
          x: span.min_x + rand() * (span.max_x - span.min_x), z: span.min_z + rand() * (span.max_z - span.min_z), width: 8, depth: 12,
        });
        if (r.length) conflicted++;
      }
      const footprintMs = ms(t);

      t = performance.now();
      // The overlay's own render preparation (WP4): merged buffers per class and state.
      const overlay = buildOverlayGeometry([
        ...(bundle.land ?? []), ...(bundle.water ?? []), ...(bundle.protected ?? []),
        ...(bundle.routes ?? []), ...(bundle.sites ?? []),
      ].map(f => ({ ...f, lifecycle_state: 'accepted' as const })));
      const renderPrepMs = ms(t);
      const triangles = overlay.fills.reduce((s, g) => s + g.indexCount / 3, 0);
      const lineVertices = overlay.lines.reduce((s, g) => s + g.positions.length / 3, 0);

      results[name] = {
        features: (bundle.land?.length ?? 0) + (bundle.water?.length ?? 0) + (bundle.sites?.length ?? 0) + (bundle.routes?.length ?? 0),
        parse_ms: parseMs,
        adapter_build_ms: buildMs,
        classify_points: POINTS,
        classify_ms: classifyMs,
        classify_us_per_point: +((classifyMs * 1000) / POINTS).toFixed(2),
        classify_tally: tally,
        footprints: FOOTPRINTS,
        footprint_ms: footprintMs,
        footprints_conflicted: conflicted,
        render_prep_ms: renderPrepMs,
        render_objects: overlay.fills.length + overlay.lines.length + overlay.points.length,
        fill_triangles: triangles,
        line_vertices: lineVertices,
      };
      expect(tally.land + tally.water + tally.unknown).toBe(POINTS);
    }
    writeFileSync(join(DIR!, 'frontend-measure.json'), JSON.stringify(results, null, 2));
  });
});
