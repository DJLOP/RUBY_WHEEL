/**
 * Import boundaries of the canonical-geography module (plan §6.7, §10).
 *
 * - Nothing in the module except the tracing/manager UI may import reference layers: the
 *   raster is evidence for a human tracing, never an input to canon or to generation.
 * - The generator seam (`constraints.ts`) and its pure companions import nothing from
 *   React, Three.js, the network, or reference layers, so generation can later move to
 *   the server against the same bundle.
 * - The inherited generator (`cityGen`) never imports reference layers.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';

const SRC = resolve(__dirname, '../../..');
const MODULE = resolve(__dirname, '..');

/** Files allowed to read reference layers: in-scene tracing and the manager panel (WP5+). */
const RASTER_UI = new Set(['TracingTool.tsx', 'CanonicalGeographyManager.tsx']);
/** Pure modules: no UI framework, renderer, network or raster. */
const PURE = ['types.ts', 'constraints.ts', 'physicalScale.ts', 'geometry.ts', 'tracing.ts', 'featureEditing.ts',
  'landSelection.ts', 'scopes.ts', 'anchors.ts', 'connections.ts', 'mapPick.ts', 'scopeContents.ts'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Every module specifier a source file imports or re-exports, statically or dynamically. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const found: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) found.push(m[1] ?? m[2] ?? m[3]);
  return found;
}

const touchesReferenceLayers = (spec: string) => /referenceLayers|reference-layers/.test(spec);

describe('canonical geography import boundaries', () => {
  const files = walk(MODULE);

  it('checks the pure seam files', () => {
    for (const f of PURE) expect(files.map(p => relative(MODULE, p))).toContain(f);
  });

  it.each(files.map(f => relative(MODULE, f)))('%s imports reference layers only if it is tracing/manager UI', (rel) => {
    if (RASTER_UI.has(rel)) return;
    expect(specifiers(join(MODULE, rel)).filter(touchesReferenceLayers)).toEqual([]);
  });

  it.each(PURE)('%s imports no React, Three.js, network or reference layers', (rel) => {
    const file = join(MODULE, rel);
    const bad = specifiers(file).filter(s =>
      /^react($|\/|-dom)|^three($|\/)|^@react-three\/|socket\.io|axios|useApi|\/api$|\/hooks\//.test(s) || touchesReferenceLayers(s));
    expect(bad).toEqual([]);
    const code = readFileSync(file, 'utf8');
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage/);
  });

  it('keeps the generator away from reference layers', () => {
    const offenders = walk(join(SRC, 'cityGen'))
      .filter(f => specifiers(f).some(touchesReferenceLayers))
      .map(f => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
