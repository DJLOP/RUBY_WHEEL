// Characters Without Number exports (characterswithoutnumber.app).
//
// CharWN exports a Foundry VTT actor, so the file carries the same character twice: once
// in Foundry's own shape (`system` plus an `items` array) and once in CharWN's, under
// `flags["characters-without-number"].character`.
//
// Both are used, because each is better at something. The flags block is the cleaner
// record of what the character IS - attributes, skills by id, saving throws. The items
// array is the only place the detail lives: a weapon's trauma die and shock, an implant's
// strain and concealment, an item's Encumbrance and whether it is readied.
//
// **This is an adapter, not a second importer.** It flattens the export into the same flat
// candidate keys a filled-in PDF produces - `Name`, `Strength`, `Shoot`, `Weapon1Dmg`,
// `Cyber1Strain` - and hands them to the ordinary CWN mapper. Everything downstream then
// works unchanged: the alias table, the skill-word normaliser, the inventory parser, and
// the socket's cyberware gather that turns twelve numbered boxes into rows.
//
// So the rule for extending this is: emit a label the FORM already prints. If there is no
// box for something, that is a gap in the form rather than a reason to bypass the mapper.

const FLAG = 'characters-without-number';

/** The CharWN block inside a Foundry actor, or null if this is not one of their exports. */
const charwnBlock = (json) => {
  if (!json || typeof json !== 'object') return null;
  const flags = json.flags && typeof json.flags === 'object' ? json.flags : null;
  const mine = flags && flags[FLAG];
  return mine && typeof mine === 'object' ? mine : null;
};

/**
 * Whether this looks like a CharWN export.
 *
 * The flag is the test rather than the Foundry envelope: plenty of things export a Foundry
 * actor, and only CharWN writes this block. A file that has the block but nothing in it is
 * still theirs, and will simply produce little.
 */
const isCharwnExport = (json) => charwnBlock(json) !== null;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The first candidate that is actually a number, or undefined.
 *
 * The distinction matters more than it looks: `num(undefined)` is 0, so coercing straight
 * to a number would emit "AC 0" for an export that simply does not mention AC - and an
 * import that overwrites a real value with a zero nobody typed is worse than one that
 * leaves the field alone. A present zero is still a zero, and still emitted.
 */
const pick = (...values) => {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

/** Strip the HTML their notes fields carry, so a sheet does not show markup. */
const plain = (html) => str(html)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>\s*<p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const itemsOfType = (json, type) =>
  (Array.isArray(json.items) ? json.items : []).filter((i) => i && i.type === type);

/**
 * Their trauma shape as the sheet writes it.
 *
 * CharWN keeps `{ die: "1d8", rating: 2 }`; the sheet stores "d8/x2", which is what the
 * resolver parses. A weapon with no die has no trauma rather than a trauma of nothing.
 */
const traumaOf = (weapon) => {
  const t = weapon.trauma;
  if (!t) return '';
  const die = str(t.die).replace(/^1d/i, 'd');
  if (!/^d\d+$/i.test(die)) return '';
  return `${die}/x${num(t.rating) || 1}`;
};

/**
 * Their shock shape as the sheet writes it, or nothing.
 *
 * `{ dmg: "0", ac: 10 }` is how CharWN spells "this weapon has no shock", so it is dropped
 * rather than stored as a shock of zero - the sheet would then print a shock column for a
 * pistol that has none.
 */
const shockOf = (weapon) => {
  const s = weapon.shock;
  if (!s) return '';
  const dmg = num(s.dmg);
  if (dmg <= 0) return '';
  return `${dmg}/${num(s.ac) || 10}`;
};

/** Their attribute word as the sheet's, with a pair collapsing the way the book does. */
const attrOf = (weapon) => {
  const first = str(weapon.stat).toLowerCase();
  const second = str(weapon.secondStat).toLowerCase();
  if (first && second) return `${first}/${second}`;
  return first;
};

/**
 * Everything the character is carrying that is not a weapon, as inventory rows.
 *
 * Emitted as JSON rather than as a written line, which the importer would also accept:
 * their item names contain commas ("Kit, Cyberdoc") and the line parser splits on those,
 * so a line would quietly turn one kit into two items.
 */
const inventoryOf = (json) => itemsOfType(json, 'item').map((item) => {
  const sys = item.system || {};
  const bundle = sys.bundle || {};
  return {
    name: str(item.name),
    qty: Math.max(1, num(sys.quantity) || 1),
    enc: sys.encumbrance === null || sys.encumbrance === undefined ? '' : String(num(sys.encumbrance)),
    bundled: bundle.bundled === true,
    // Their vocabulary is ours: readied, stowed, and anything else is not on the character.
    carry: ['readied', 'stowed'].includes(str(sys.location).toLowerCase())
      ? str(sys.location).toLowerCase()
      : 'stash',
    location: '',
  };
});

/** Foci and edges, as the line the sheet keeps them on. */
const featureLines = (json, kind) => itemsOfType(json, 'feature')
  .filter((f) => str((f.system || {}).type).toLowerCase() === kind)
  .map((f) => {
    const level = num((f.system || {}).level);
    return level > 1 ? `${str(f.name)} ${level}` : str(f.name);
  })
  .filter(Boolean);

/** Their contacts, which are features wearing a flag. */
const contactLines = (json) => itemsOfType(json, 'feature')
  .map((f) => ((f.flags || {})[FLAG] || {}).contact)
  .filter(Boolean)
  .map((c) => [str(c.name), str(c.profession), str(c.relationship), plain(c.description)]
    .filter(Boolean).join(' — '));

/**
 * A CharWN export as the candidate keys a filled-in form produces.
 *
 * Labels here must be ones the printed form uses, because those are what the alias table
 * recognises - see the header. Anything absent is simply left out rather than emitted
 * blank, so an import never overwrites a field with nothing.
 */
const toCandidates = (json) => {
  const block = charwnBlock(json);
  if (!block) return null;
  const character = (block.character && typeof block.character === 'object') ? block.character : {};
  const sys = json.system && typeof json.system === 'object' ? json.system : {};
  const out = {};
  const put = (key, value) => {
    if (value === '' || value === null || value === undefined) return;
    out[key] = value;
  };

  // ── Identity ──────────────────────────────────────────────────────────────
  put('Name', str(json.name) || str(character.name));
  put('Class', str(sys.class) || str(character.classId));
  put('Background', str(sys.background) || str(character.backgroundId));
  put('Level', pick((sys.level || {}).value, character.level));
  put('XP', pick((sys.level || {}).exp, character.experience));
  put('Faction', str(sys.employer) || str(character.employer));
  // Their species, homeworld and goals have no field of their own on this sheet, so they
  // go where a player would read them rather than being dropped.
  put('Description', [
    str(sys.species) && `Species: ${str(sys.species)}`,
    str(sys.homeworld) && `Homeworld: ${str(sys.homeworld)}`,
    str(sys.goals) && `Goals: ${str(sys.goals)}`,
  ].filter(Boolean).join(' · '));
  put('Languages', (Array.isArray(sys.languages) ? sys.languages : []).map(str).filter(Boolean).join(', '));

  // ── Attributes ────────────────────────────────────────────────────────────
  const stats = sys.stats || {};
  const attrs = character.attributes || {};
  const attr = (short, long) => pick((stats[short] || {}).base, attrs[long]);
  put('Strength', attr('str', 'strength'));
  put('Dexterity', attr('dex', 'dexterity'));
  put('Constitution', attr('con', 'constitution'));
  put('Intelligence', attr('int', 'intelligence'));
  put('Wisdom', attr('wis', 'wisdom'));
  put('Charisma', attr('cha', 'charisma'));

  // ── Combat ────────────────────────────────────────────────────────────────
  // Their baseAc/meleeAc are the character's effective ACs rather than a suit's printed
  // values, so they land on AC rather than on the armour block - which stays empty, which
  // is correct for a character wearing nothing.
  put('AC', pick(sys.baseAc, character.armorClass));
  put('Base Hit Bonus', pick(sys.ab, character.attackBonus));
  put('Trauma Target', pick(sys.traumaTarget));
  put('System Strain', pick((sys.systemStrain || {}).value, character.systemStrainCurrent));
  // Hit points and cash are linked fields here - they live on the token and the bank - so
  // they are emitted only to be reported as skipped rather than to look unrecognised.
  put('HP', pick((sys.health || {}).value));
  put('HPMax', pick((sys.health || {}).max));
  put('Cash', pick((sys.credits || {}).carriedBase, character.credits));

  // ── Skills ────────────────────────────────────────────────────────────────
  // By the id on the flag rather than by the item's name: the id is their contract and the
  // name is a label. Both happen to match ours today, and only one of them is promised to.
  for (const item of itemsOfType(json, 'skill')) {
    const id = str((((item.flags || {})[FLAG]) || {}).skillId);
    if (!id) continue;
    out[id] = num((item.system || {}).rank);
  }

  // ── Weapons ───────────────────────────────────────────────────────────────
  itemsOfType(json, 'weapon').forEach((weapon, i) => {
    const n = i + 1;
    const w = weapon.system || {};
    put(`Weapon${n}Name`, str(weapon.name));
    put(`Weapon${n}Dmg`, str(w.damage));
    put(`Weapon${n}Skill`, str(w.skill));
    put(`Weapon${n}Attr`, attrOf(w));
    put(`Weapon${n}Trauma`, traumaOf(w));
    put(`Weapon${n}Shock`, shockOf(w));
    put(`Weapon${n}Atk`, pick(w.ab));
    put(`Weapon${n}Enc`, pick(w.encumbrance));
    put(`Weapon${n}Carry`, str(w.location));
  });

  // ── Cyberware ─────────────────────────────────────────────────────────────
  // Their type and concealment words are already ours once lowercased - Head, Sensory,
  // Nerve, Limb, Body, and Touch, Medical, Sight, Obvious - so no translation table is
  // needed, and inventing one would be somewhere for the two to drift.
  itemsOfType(json, 'cyberware').forEach((piece, i) => {
    const n = i + 1;
    const c = piece.system || {};
    put(`Cyber${n}Name`, str(piece.name));
    put(`Cyber${n}Type`, str(c.type).toLowerCase());
    put(`Cyber${n}Strain`, pick(c.strain));
    put(`Cyber${n}Cost`, pick(c.cost));
    put(`Cyber${n}Conc`, str(c.concealment).toLowerCase());
    put(`Cyber${n}Effect`, plain(c.effect) || plain(c.description));
  });

  // ── The lists that stay lists ─────────────────────────────────────────────
  const inventory = inventoryOf(json);
  if (inventory.length) put('Inventory', JSON.stringify(inventory));
  put('Foci', [
    ...featureLines(json, 'focus').map((f) => `Focus: ${f}`),
    ...featureLines(json, 'edge').map((e) => `Edge: ${e}`),
  ].join('\n'));
  put('Contacts', contactLines(json).join('\n'));
  put('Gear', plain(sys.biography) || plain((character.journal || {}).generalNotes));

  return out;
};

module.exports = { FLAG, isCharwnExport, toCandidates, plain, traumaOf, shockOf, inventoryOf };
