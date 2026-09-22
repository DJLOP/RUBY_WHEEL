/**
 * Reference layers belong to the canonical world and to nothing else.
 *
 * A battle map is a separate scene with its own camera, its own scale and its own plane at
 * the origin. A city drawing calibrated to world X/Z means nothing there, and drawing one
 * into it would put a several-thousand-unit plane under somebody's floor plan.
 *
 * The two scenes are branches of one Canvas in `App.tsx`, so the boundary is a question of
 * which branch the element sits in. That is checked against the source, because it is a
 * structural fact rather than a runtime one: the battle-map branch cannot be rendered with
 * a reference layer to observe, since it is never handed one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8');

describe('reference layers are confined to the world scene', () => {
  const app = read('App.tsx');

  it('renders the layers exactly once', () => {
    expect(app.match(/<ReferenceLayers\b/g)).toHaveLength(1);
  });

  it('renders them in the world branch, after the battle-map branch has closed', () => {
    const battleBranch = app.indexOf("view === 'battle_map' ? (");
    const battleScene = app.indexOf('<BattleMapScene');
    // The perspective camera is the first thing in the world branch of that ternary.
    const worldBranch = app.indexOf('<PerspectiveCamera makeDefault');
    const layers = app.indexOf('<ReferenceLayers');

    expect(battleBranch).toBeGreaterThan(-1);
    expect(battleScene).toBeGreaterThan(battleBranch);
    expect(worldBranch).toBeGreaterThan(battleScene);
    expect(layers).toBeGreaterThan(worldBranch);
  });

  it('is not reachable from the battle-map scene at all', () => {
    const scene = read('BattleMapScene.tsx');
    expect(scene).not.toMatch(/referenceLayers|ReferenceLayers|reference-layers/i);
  });

  it('does not push reference imagery into the battle-map manager', () => {
    expect(read('BattleMapManager.tsx')).not.toMatch(/referenceLayers|ReferenceLayers|reference-layers/i);
  });
});
