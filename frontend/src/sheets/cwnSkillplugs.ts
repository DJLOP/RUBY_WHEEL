// Skillplugs (CWN p64), mirrored for the sheet.
//
// backend/sheets/cwnSkillplugs.js is authoritative: the server resolves the rolls, so its
// copy decides whether a plug actually grants anything and whether the jack crashes. This
// one exists because the sheet has to draw the BASE a skill rolls at and the controls that
// load a plug, and the frontend cannot import the server's CommonJS module.
//
// A test cross-checks the two, so a rule edited on one side and not the other fails there
// rather than in somebody's game.

import { readInventory, writeInventory, INVENTORY_FIELD, type InventoryItem } from './inventory';

export const PLUG_FIELD = 'skillplugs';
export const PLUG_LOCKED_FIELD = 'skillplug_locked';

/** Which systems have skillplugs. p64 is a Cities Without Number table. */
const PLUG_SYSTEMS = new Set(['cities_without_number']);
export const hasSkillplugs = (system: string | null | undefined): boolean =>
  PLUG_SYSTEMS.has(String(system ?? ''));

/**
 * Which skills a basic Jack I can carry.
 *
 * OURS, not the book's. p64 gives a principle - "intellectual skills that require only
 * modest physical expertise" - and six examples: Know, Fix and Heal qualify, Shoot, Exert
 * and most Perform do not. The rest is a reading, which is why nothing refuses a plug: the
 * sheet explains that a Jack I may not carry this one and lets the table decide.
 */
export const INTELLECTUAL = new Set([
  'administer', 'connect', 'fix', 'heal', 'know', 'lead', 'notice',
  'program', 'survive', 'talk', 'trade', 'work', 'cast_skill', 'summon_skill',
]);

export const isIntellectual = (skillId: string): boolean =>
  INTELLECTUAL.has(String(skillId ?? '').trim().toLowerCase());

/** The book's price table. Level-3 is "N/A" - not something you walk in and buy. */
export const PLUG_PRICES: Record<number, number | null> = { 0: 1000, 1: 10000, 2: 50000, 3: null };

export const plugPrice = (level: number, skillId: string): number | null => {
  const base = PLUG_PRICES[Number(level)];
  if (base === null || base === undefined) return null;
  return isIntellectual(skillId) ? base : base * 2;
};

export interface Skillplug { skill: string; level: number }

export interface Jack {
  kind: null | 'i' | 'ii';
  wired: boolean;
  maxLevel: number;
  allowsPhysical: boolean;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const JACK_I = 'skillplug jack i';
const JACK_II = 'skillplug jack ii';
const WIRING = 'skillplug wiring';

/** What hardware is installed. A jack in a box interfaces with nothing. */
export const jackOf = (data: Record<string, unknown> | undefined | null): Jack => {
  const rows = Array.isArray(data?.cyberware) ? (data!.cyberware as Record<string, unknown>[]) : [];
  let kind: Jack['kind'] = null;
  let wired = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.equipped === false || row.placed === false) continue;
    const name = String(row.name ?? '').trim().toLowerCase();
    if (name === JACK_II) kind = 'ii';
    else if (name === JACK_I && kind !== 'ii') kind = 'i';
    else if (name === WIRING) wired = true;
  }
  return {
    kind,
    wired,
    maxLevel: kind === null ? -1 : (wired ? 3 : 1),
    allowsPhysical: kind === 'ii',
  };
};

export const normalisePlug = (raw: unknown): Skillplug => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    skill: String(r.skill ?? '').trim().toLowerCase(),
    level: Math.max(0, Math.min(3, Math.floor(num(r.level)))),
  };
};

/** What is loaded, keeping the better of two plugs for one skill. */
export const loaded = (data: Record<string, unknown> | undefined | null): Skillplug[] => {
  let value: unknown = data?.[PLUG_FIELD];
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const best = new Map<string, Skillplug>();
  for (const raw of value) {
    const plug = normalisePlug(raw);
    if (!plug.skill) continue;
    const seen = best.get(plug.skill);
    if (!seen || plug.level > seen.level) best.set(plug.skill, plug);
  }
  return [...best.values()];
};

export const writePlugs = (list: Skillplug[]): string => JSON.stringify(list);

export const isLocked = (data: Record<string, unknown> | undefined | null): boolean => {
  const v = data?.[PLUG_LOCKED_FIELD];
  return v === true || v === 1 || v === '1' || v === 'true';
};

/** The plugs actually doing something: none without a jack, none while it is down. */
export const running = (data: Record<string, unknown> | undefined | null): Skillplug[] => {
  if (isLocked(data)) return [];
  const jack = jackOf(data);
  if (jack.kind === null) return [];
  return loaded(data).filter((p) => {
    if (p.level > jack.maxLevel) return false;
    if (!jack.allowsPhysical && !isIntellectual(p.skill)) return false;
    return true;
  });
};

export const plugLevel = (
  data: Record<string, unknown> | undefined | null, skillId: string,
): number | null => {
  const skill = String(skillId ?? '').trim().toLowerCase();
  const hit = running(data).find((p) => p.skill === skill);
  return hit ? hit.level : null;
};

/** The better of the plug and what the character earned. */
export const effectiveSkill = (
  data: Record<string, unknown> | undefined | null, skillId: string,
): number => {
  const own = num(data?.[skillId]);
  const plug = plugLevel(data, skillId);
  return plug === null ? own : Math.max(own, plug);
};

/** How low a natural roll has to be to crash the jack. 0 means nothing can. */
export const failureBand = (
  data: Record<string, unknown> | undefined | null, shape: 'skill' | 'attack',
): number => {
  const count = running(data).length;
  if (!count) return 0;
  return (shape === 'attack' ? 1 : 2) + (count - 1);
};

/** Why a plug in this inventory row cannot be loaded, or null if it can. */
export const loadable = (
  data: Record<string, unknown> | undefined | null, item: InventoryItem,
): { plug: Skillplug | null; ok: boolean; why: string } => {
  const plug = plugFromName(item.name);
  if (!plug) return { plug: null, ok: false, why: '' };
  if (isLocked(data)) {
    return { plug, ok: false, why: 'The jack has crashed and is down until the scene ends.' };
  }
  const jack = jackOf(data);
  if (jack.kind === null) {
    return { plug, ok: false, why: 'No skillplug jack installed.' };
  }
  if (!jack.allowsPhysical && !isIntellectual(plug.skill)) {
    return {
      plug, ok: false,
      why: `A Jack I carries intellectual plugs only - our reading of p64, which gives a principle rather than a list. A Jack II carries anything.`,
    };
  }
  if (plug.level > jack.maxLevel) {
    return {
      plug, ok: false,
      why: `Level-${plug.level} plugs need Skillplug Wiring; this jack reaches level-${jack.maxLevel}.`,
    };
  }
  if (item.carry !== 'readied') {
    return {
      plug, ok: false,
      why: 'Ready it first. Loading a plug is a Main Action and reaching a Stowed item is another.',
    };
  }
  if (loaded(data).some((p) => p.skill === plug.skill && p.level >= plug.level)) {
    return { plug, ok: false, why: 'Already running a plug at least this good for that skill.' };
  }
  return { plug, ok: true, why: `Load ${plug.skill.toUpperCase()}-${plug.level}` };
};

/**
 * A plug read off an inventory row's name.
 *
 * Plugs are carried like any other small object, so the row's name is the contract:
 * "Skillplug: Fix-1" or "Plug Fix 1". Anything else is not a plug.
 */
export const plugFromName = (name: string): Skillplug | null => {
  const m = /^\s*(?:skill)?plug\s*[:\-]?\s*([a-z_ ]+?)\s*[-\s]\s*(\d)\s*$/i.exec(String(name ?? ''));
  if (!m) return null;
  const skill = m[1].trim().toLowerCase().replace(/\s+/g, '_');
  return { skill, level: Math.max(0, Math.min(3, Number(m[2]))) };
};

/** The name a plug is carried under, so the shop and the parser agree. */
export const plugItemName = (plug: Skillplug): string =>
  `Skillplug: ${plug.skill.replace(/_/g, ' ')}-${plug.level}`;

/**
 * Loading the plug in one inventory row.
 *
 * Unlike a dose, a plug is NOT consumed - it is a cylinder you slot and can pull back out -
 * so the row stays where it is. What changes is only what is running.
 */
export const loadFromRow = (
  data: Record<string, unknown> | undefined | null, index: number,
): Record<string, string | number> | null => {
  const items = readInventory(data);
  const item = items[index];
  if (!item) return null;
  const { plug, ok } = loadable(data, item);
  if (!plug || !ok) return null;
  const next = [...loaded(data).filter((p) => p.skill !== plug.skill), plug];
  return { [PLUG_FIELD]: writePlugs(next) };
};

/** Pulling a plug back out. It was never spent, so nothing comes back to the inventory. */
export const unload = (
  data: Record<string, unknown> | undefined | null, skillId: string,
): Record<string, string | number> => ({
  [PLUG_FIELD]: writePlugs(loaded(data).filter((p) => p.skill !== skillId)),
});

/** The scene ending: the jack comes back up, and whatever was loaded works again. */
export const clearCrash = (): Record<string, string | number> => ({ [PLUG_LOCKED_FIELD]: '' });

export { readInventory, writeInventory, INVENTORY_FIELD };
