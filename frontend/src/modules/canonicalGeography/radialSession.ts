/**
 * The radial constructor's shared, nonpersistent state (plan §15.6): what the panel
 * previews, and which map click it is waiting for.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The panel (in the DOM)
 * and the in-scene preview (in the canvas) read one store, like the tracing session and
 * map-pick stores. Nothing here is ever sent to the server; closing the tool resets it.
 */

import type { WorldXZ, BBox } from './types';
import type { SpokeReport } from './radialConstruction';

/**
 * Which map click the panel is waiting for, if any. `inner_circle`/`outer_circle` collect the
 * defining clicks of an inline circle boundary (the shape creator's circle methods).
 */
export type RadialPickMode = 'inner' | 'outer' | 'center' | 'center_feature' | 'aim' | 'inner_circle' | 'outer_circle';

/** Pick modes that take several clicks; the panel ends them once the circle is defined. */
export const isCirclePick = (m: RadialPickMode | null) => m === 'inner_circle' || m === 'outer_circle';

export interface RadialMapRequest {
  /** Increments per click, so the same click twice is still two requests. */
  nonce: number;
  mode: RadialPickMode;
  /** The ground point, snapped to saved vertices/edges for a center click. */
  at: WorldXZ;
  /** Canonical features under the click, most specific first (boundary and center-feature picks). */
  ids: number[];
}

export interface RadialPreview {
  center: WorldXZ | null;
  spokes: SpokeReport[];
  /** Where an invalid spoke's error ray stops: the outer ring's bbox. */
  outerBBox: BBox | null;
  /**
   * Inline circle boundaries: not canonical features, so drawn here. `materialize`: it will
   * also be created as a canonical draft on Create (drawn differently from input-only).
   */
  circles?: { ring: WorldXZ[]; materialize: boolean }[];
  /** Their defining clicks so far. */
  circlePoints?: WorldXZ[];
}

export interface RadialSceneState {
  /** The constructor is open; the preview draws only then. */
  active: boolean;
  pickMode: RadialPickMode | null;
  request: RadialMapRequest | null;
  preview: RadialPreview | null;
  /** A spoke-table row hovered: its spoke is highlighted in the scene. */
  hoverIndex: number | null;
}

export const IDLE_RADIAL: RadialSceneState = { active: false, pickMode: null, request: null, preview: null, hoverIndex: null };

export interface RadialSession {
  getState: () => RadialSceneState;
  subscribe: (listener: () => void) => () => void;
  update: (edit: (s: RadialSceneState) => RadialSceneState) => void;
}

export function createRadialSession(initial: RadialSceneState = IDLE_RADIAL): RadialSession {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (edit) => {
      const next = edit(state);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
  };
}

/** A map click for the mode the panel is waiting for; a single-click mode ends with it. */
export const requestRadialPick = (s: RadialSceneState, at: WorldXZ, ids: number[]): RadialSceneState =>
  (s.pickMode ? {
    ...s, pickMode: isCirclePick(s.pickMode) ? s.pickMode : null,
    request: { nonce: (s.request?.nonce ?? 0) + 1, mode: s.pickMode, at, ids },
  } : s);

/**
 * Where a ray from `c` at `angleDeg` leaves `box` (for drawing an invalid spoke), or null
 * when `c` is outside the box.
 */
export function rayToBBox(c: WorldXZ, angleDeg: number, box: BBox): WorldXZ | null {
  if (c.x < box.min_x || c.x > box.max_x || c.z < box.min_z || c.z > box.max_z) return null;
  const r = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(r);
  const dz = Math.sin(r);
  const ts: number[] = [];
  if (dx > 1e-12) ts.push((box.max_x - c.x) / dx);
  if (dx < -1e-12) ts.push((box.min_x - c.x) / dx);
  if (dz > 1e-12) ts.push((box.max_z - c.z) / dz);
  if (dz < -1e-12) ts.push((box.min_z - c.z) / dz);
  const t = Math.min(...ts);
  return Number.isFinite(t) ? { x: c.x + dx * t, z: c.z + dz * t } : null;
}
