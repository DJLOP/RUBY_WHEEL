import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * What a frontend test may reach into the backend for.
 *
 * Sixteen tests here import a backend module on purpose: this project mirrors the rules
 * into both languages - the server decides outcomes, the sheet has to draw the same
 * numbers - and the only way mirroring is safe is to walk both copies in one test. That is
 * a feature and stays.
 *
 * The constraint is narrower: **a backend module reached from here must not require a
 * third-party package.** These suites run with only the frontend's dependencies installed,
 * so a backend module that pulls `pdf-lib` resolves on a developer's machine, where both
 * node_modules exist, and fails in CI where they do not.
 *
 * That is exactly how it got through. The stash round-trip test imported `importers.js`,
 * passed locally, and broke the build - an hour after being called green. Nothing said the
 * rule, so nothing could enforce it. This does.
 *
 * If a test genuinely needs a module with dependencies, the answer is to assert that half
 * on the backend, where the dependency exists, and pin the shape at both ends - which is
 * what cwnWeaponStash.test.ts now does.
 */

const FRONTEND_SRC = resolve(__dirname, '..');
const REPO = resolve(__dirname, '../../..');

/** Node's own modules are always resolvable and are not the problem. */
const BUILT_IN = new Set(['fs', 'path', 'crypto', 'util', 'os', 'url', 'events', 'stream']);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.test\.tsx?$/.test(entry) ? [full] : [];
  });

/** Every backend module path a test file reaches for. */
const backendImportsIn = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/['"]([^'"]*\.\.\/backend\/[^'"]+)['"]/g)].map((m) => m[1]);
};

/** The third-party packages a backend module requires, transitively through its own kin. */
const thirdPartyDeps = (modulePath: string, seen = new Set<string>()): string[] => {
  if (seen.has(modulePath)) return [];
  seen.add(modulePath);
  let src: string;
  try { src = readFileSync(modulePath, 'utf8'); } catch { return []; }

  const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const out: string[] = [];
  for (const dep of required) {
    if (dep.startsWith('.')) {
      // A sibling module: whatever IT pulls in is pulled in here too.
      const next = resolve(modulePath, '..', dep.endsWith('.js') ? dep : `${dep}.js`);
      out.push(...thirdPartyDeps(next, seen));
    } else if (!BUILT_IN.has(dep.replace(/^node:/, ''))) {
      out.push(dep);
    }
  }
  return [...new Set(out)];
};

describe('what a frontend test may import from the backend', () => {
  const testFiles = walk(FRONTEND_SRC);

  it('finds the test files to check, so an empty pass is not a pass', () => {
    expect(testFiles.length).toBeGreaterThan(50);
  });

  it('never reaches a backend module that needs a package this suite has not got', () => {
    const offenders: string[] = [];

    for (const file of testFiles) {
      for (const imported of backendImportsIn(file)) {
        // Tests importing other tests are their own business; only modules matter here.
        if (imported.includes('/__tests__/')) continue;
        const abs = resolve(file, '..', imported.endsWith('.js') ? imported : `${imported}.js`);
        const deps = thirdPartyDeps(abs);
        if (deps.length) {
          offenders.push(
            `${file.slice(REPO.length + 1)} imports ${imported} which needs ${deps.join(', ')}`,
          );
        }
      }
    }

    // Named rather than counted, so a failure says which file and which package and the
    // fix is obvious without reading this test.
    expect(offenders).toEqual([]);
  });
});
