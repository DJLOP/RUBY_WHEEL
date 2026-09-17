// Skillplugs (CWN p64).
//
// Small brightly-coloured cylinders that grant a facsimile of expertise. A plug jack and a
// Main Action load one; while it is loaded the character has that skill at the plug's
// level, and when it comes out they do not.
//
// **The jack is cyberware and already exists** in the catalogue - Skillplug Jack I, Jack II
// and Skillplug Wiring, with the book's strain and prices. What this module adds is the
// plugs themselves, what they grant, and what they cost you when the dice go wrong.
//
// **Applied on read, never written back**, like the chrome and the drugs: unslotting a plug
// has to give the skill back exactly as it was, and the only way to be certain is never to
// have stored it.
//
// **The cost is real and the app enforces it.** A natural 2 on a plug-augmented skill check
// or a natural 1 on a plug-augmented attack is an automatic failure that no reroll can
// save, and the jack then locks up for the scene. Each plug past the first widens that band
// by one, which is the book pricing the temptation to run several at once - on 2d6 the odds
// climb steeply, from 1 in 36 to 1 in 6 by the third plug.

/** What is loaded right now: a JSON array of { skill, level }. */
const FIELD = 'skillplugs';

/** Whether the jack has crashed and is dead until the scene ends. */
const LOCKED_FIELD = 'skillplug_locked';

/**
 * Which skills a basic Jack I can carry.
 *
 * The book gives a principle and six examples rather than a list: plugs for "intellectual
 * skills that require only modest physical expertise", where "Know, Fix, or Heal could
 * qualify for this, but Shoot, Exert, or most forms of Perform would not."
 *
 * So this classification is OURS, anchored on those six. It is a reading the book declined
 * to make, which is why nothing here refuses a plug - the sheet says a Jack I may not carry
 * this one and lets the table decide, the same way the cyberware mod picker explains rather
 * than hides.
 *
 * The judgement calls worth naming: Notice and Survive are wits rather than muscle and are
 * in; Drive and Sneak are whole-body skills and are out; Connect, Lead, Talk and Trade are
 * social rather than physical, and nothing in the rule excludes them.
 */
const INTELLECTUAL = new Set([
  'administer', 'connect', 'fix', 'heal', 'know', 'lead', 'notice',
  'program', 'survive', 'talk', 'trade', 'work', 'cast_skill', 'summon_skill',
]);

/** Everything else needs a Jack II: Drive, Exert, Perform, Punch, Shoot, Sneak, Stab. */
const isIntellectual = (skillId) => INTELLECTUAL.has(String(skillId || '').trim().toLowerCase());

/**
 * The book's price table.
 *
 * Level-3 is "N/A" - vanishingly rare, and rumoured to need an expert's neural tissue - so
 * it has no price and cannot be bought. A physical-based skill doubles whatever it costs.
 */
const PLUG_PRICES = { 0: 1000, 1: 10000, 2: 50000, 3: null };

const plugPrice = (level, skillId) => {
  const base = PLUG_PRICES[Number(level)];
  if (base === null || base === undefined) return null;
  return isIntellectual(skillId) ? base : base * 2;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The names the cyberware catalogue gives the three implants. */
const JACK_I = 'skillplug jack i';
const JACK_II = 'skillplug jack ii';
const WIRING = 'skillplug wiring';

/**
 * What hardware the character has, read off their installed chrome.
 *
 * Installed and placed, not merely owned: a jack in a box on the table interfaces with
 * nothing. That is the same test the rest of the cyberware effects use.
 */
const jackOf = (data) => {
  const rows = Array.isArray(data && data.cyberware) ? data.cyberware : [];
  let kind = null;
  let wired = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.equipped === false || row.placed === false) continue;
    const name = String(row.name || '').trim().toLowerCase();
    if (name === JACK_II) kind = 'ii';
    else if (name === JACK_I && kind !== 'ii') kind = 'i';
    else if (name === WIRING) wired = true;
  }
  return {
    kind,
    wired,
    // Commonly available plugs are level-0 and level-1. Wiring raises the ceiling to 3,
    // which covers the rare level-2 and the vanishingly rare level-3 alike.
    maxLevel: kind === null ? -1 : (wired ? 3 : 1),
    allowsPhysical: kind === 'ii',
  };
};

/** One loaded plug, with every field present whatever it was handed. */
const normalisePlug = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    skill: String(r.skill || '').trim().toLowerCase(),
    // Levels run 0 to 3. Anything else is a sheet somebody hand-edited.
    level: Math.max(0, Math.min(3, Math.floor(num(r.level)))),
  };
};

/**
 * What is loaded, deduplicated by skill.
 *
 * Two plugs for the same skill is not a thing the rules recognise - the better one simply
 * wins - so the higher level is kept and the other dropped rather than both being counted
 * toward the crosstalk band.
 */
const loaded = (data) => {
  let value = data ? data[FIELD] : null;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const best = new Map();
  for (const raw of value) {
    const plug = normalisePlug(raw);
    if (!plug.skill) continue;
    const seen = best.get(plug.skill);
    if (!seen || plug.level > seen.level) best.set(plug.skill, plug);
  }
  return [...best.values()];
};

/** Whether the jack has crashed and is doing nothing until the scene ends. */
const isLocked = (data) => !!(data && (data[LOCKED_FIELD] === true || data[LOCKED_FIELD] === 1
  || data[LOCKED_FIELD] === '1' || data[LOCKED_FIELD] === 'true'));

/**
 * The plugs actually doing something.
 *
 * Nothing at all without a jack to run them, and nothing while the jack is locked up: a
 * crashed jack "locks up uselessly for the scene", which means the skill goes with it.
 * Levels above what the jack can carry are dropped rather than clamped - a Jack I cannot
 * run a level-2 plug at level 1, it cannot run it.
 */
const running = (data) => {
  if (isLocked(data)) return [];
  const jack = jackOf(data);
  if (jack.kind === null) return [];
  return loaded(data).filter((p) => {
    if (p.level > jack.maxLevel) return false;
    if (!jack.allowsPhysical && !isIntellectual(p.skill)) return false;
    return true;
  });
};

/**
 * The level a plug grants for a skill, or null.
 *
 * The better of the plug and what the character already has, decided by the caller - this
 * returns only what the plug offers.
 */
const plugLevel = (data, skillId) => {
  const skill = String(skillId || '').trim().toLowerCase();
  const hit = running(data).find((p) => p.skill === skill);
  return hit ? hit.level : null;
};

/**
 * A character's skill with their plugs counted.
 *
 * The better of the two, which is the reading that makes sense: a plug is a facsimile of
 * expertise, not a lobotomy, so slotting a level-0 plug for something you are already good
 * at does nothing rather than making you worse.
 */
const effectiveSkill = (data, skillId) => {
  const own = num(data ? data[skillId] : 0);
  const plug = plugLevel(data, skillId);
  return plug === null ? own : Math.max(own, plug);
};

/**
 * The sheet as the dice should see it, with plug-granted skills overlaid.
 *
 * Returns the original object when nothing is running, so the ordinary case allocates
 * nothing and cannot accidentally be mutated through.
 */
const withPlugs = (data) => {
  const active = running(data);
  if (!active.length) return data;
  const out = { ...data };
  for (const plug of active) out[plug.skill] = Math.max(num(data[plug.skill]), plug.level);
  return out;
};

/**
 * How low a natural roll has to be to crash the jack.
 *
 * "Whenever the user rolls a natural 2 on a skillplug-augmented skill check, or a natural 1
 * on a skillplug-augmented attack roll, the check or roll is an automatic failure that no
 * reroll ability can save." Both are the worst the dice can physically do.
 *
 * "Each additional skillplug run after the first increases the automatic failure roll range
 * by one point", so two plugs fail a check on 2 or 3 and an attack on 1 or 2.
 *
 * Returns 0 when nothing is running, which is a band no roll can fall inside.
 */
const failureBand = (data, shape) => {
  const count = running(data).length;
  if (!count) return 0;
  const floor = shape === 'attack' ? 1 : 2;
  return floor + (count - 1);
};

/**
 * Whether this natural roll crashes the jack.
 *
 * `natural` is the dice before any modifier: the sum of the 2d6 on a skill check, the face
 * of the d20 on an attack. Modifiers are deliberately not consulted - the whole point of
 * the rule is that expertise you did not earn fails in a way skill cannot rescue.
 */
const crashes = (data, shape, natural) => {
  const band = failureBand(data, shape);
  return band > 0 && num(natural) <= band;
};

/** The natural dice of a roll, for whichever shape it is. */
const naturalOf = (outcome, shape) => {
  const rolls = (outcome && outcome.rolls) || {};
  if (shape === 'attack') return num((rolls[20] || [])[0]);
  return (rolls[6] || []).reduce((a, v) => a + num(v), 0);
};

module.exports = {
  FIELD, LOCKED_FIELD, INTELLECTUAL, PLUG_PRICES,
  isIntellectual, plugPrice, jackOf, normalisePlug, loaded, isLocked, running,
  plugLevel, effectiveSkill, withPlugs, failureBand, crashes, naturalOf,
};
