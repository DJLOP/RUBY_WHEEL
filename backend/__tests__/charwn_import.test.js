import { describe, it, expect } from 'vitest';

const charwn = require('../sheets/charwn');
const cyberware = require('../sheets/cyberware');
const { getImporter } = require('../sheets/importers');

/**
 * Characters Without Number exports (characterswithoutnumber.app).
 *
 * An ADDITION, not a replacement. The adapter fires only on their own flag; a PDF, a stat
 * block, and a plain JSON paste all go exactly where they went before. The first block
 * pins that, because a new input path quietly eating the old ones is the failure that
 * would only show up when somebody's ordinary import stopped working.
 *
 * What the adapter does is flatten their export into the same candidates a filled-in form
 * produces, so everything downstream - the alias table, the skill normaliser, the
 * inventory parser, the cyberware gather - runs unchanged.
 */

const map = (candidates) => getImporter('cities_without_number').mapFields(candidates);
const through = (json) => map(charwn.toCandidates(json));

/** A minimal export: the flag is what makes it theirs. */
const actor = (over = {}) => ({
  name: 'Kestrel',
  type: 'character',
  system: { level: { value: 2, exp: 6 }, stats: { str: { base: 12 } }, ...(over.system || {}) },
  items: over.items || [],
  flags: { 'characters-without-number': { version: 1, character: over.character || {} } },
});

describe('it is an addition, not a replacement', () => {
  it('leaves a plain JSON paste alone', () => {
    const plain = { Name: 'Kestrel', Strength: 12, Shoot: 2 };
    expect(charwn.isCharwnExport(plain)).toBe(false);
    // Still maps the way it always did, through the ordinary path.
    expect(map(plain).mapped).toEqual({ name: 'Kestrel', str: 12, shoot: 2 });
  });

  it('does not claim a Foundry actor from something else', () => {
    expect(charwn.isCharwnExport({
      name: 'X', type: 'character', system: {}, items: [], flags: { 'some-other-module': {} },
    })).toBe(false);
  });

  it('does not fall over on things that are not objects', () => {
    for (const v of [null, undefined, 'text', 42, [], true]) {
      expect(charwn.isCharwnExport(v), String(v)).toBe(false);
    }
  });

  it('claims a file carrying their flag', () => {
    expect(charwn.isCharwnExport(actor())).toBe(true);
  });

  it('returns nothing to map for a file that is not theirs', () => {
    expect(charwn.toCandidates({ name: 'X' })).toBeNull();
  });
});

describe('everything it emits is something the form already prints', () => {
  it('maps cleanly, with nothing unrecognised', () => {
    // The whole design: emit a label the form uses, and the existing alias table does the
    // rest. An unmapped key here means the adapter invented a name.
    const full = actor({
      system: {
        level: { value: 2, exp: 6 }, class: 'Operator', background: 'Outlander',
        species: 'Human', homeworld: 'Kowloon', goals: 'Pay the debt', employer: 'Zaibatsu',
        baseAc: 13, ab: 1, traumaTarget: 6, systemStrain: { value: 2 },
        health: { value: 6, max: 6 }, credits: { carriedBase: 75 },
        languages: ['English (GB)', 'Cantonese'],
        stats: {
          str: { base: 9 }, dex: { base: 14 }, con: { base: 10 },
          int: { base: 8 }, wis: { base: 13 }, cha: { base: 7 },
        },
      },
      items: [
        { type: 'skill', name: 'Fix', system: { rank: 1 }, flags: { 'characters-without-number': { skillId: 'fix' } } },
        {
          type: 'weapon', name: 'Light Pistol',
          system: {
            damage: '1d6', skill: 'Shoot', stat: 'dex', encumbrance: 1, ab: 0,
            location: 'readied', trauma: { die: '1d8', rating: 2 }, shock: { dmg: '0', ac: 10 },
          },
        },
        {
          type: 'cyberware', name: 'Cranial Jack',
          system: { cost: 1000, strain: 0.25, type: 'Head', concealment: 'Touch', effect: 'A socket' },
        },
        { type: 'item', name: 'Kit, Medkit', system: { quantity: 1, encumbrance: 1, location: 'stowed' } },
      ],
    });
    const { unmapped } = through(full);
    expect(Object.keys(unmapped)).toEqual([]);
  });
});

describe('what comes across', () => {
  const full = actor({
    system: {
      level: { value: 2, exp: 6 }, class: 'Operator', background: 'Outlander',
      species: 'Human', homeworld: 'Kowloon', goals: 'Pay the debt', employer: 'Zaibatsu',
      ab: 1, systemStrain: { value: 2.5 },
      stats: {
        str: { base: 9 }, dex: { base: 14 }, con: { base: 10 },
        int: { base: 8 }, wis: { base: 13 }, cha: { base: 7 },
      },
    },
    items: [
      { type: 'skill', name: 'Fix', system: { rank: 1 }, flags: { 'characters-without-number': { skillId: 'fix' } } },
      { type: 'skill', name: 'Shoot', system: { rank: 0 }, flags: { 'characters-without-number': { skillId: 'shoot' } } },
    ],
  });

  it('brings identity and level', () => {
    expect(through(full).mapped).toMatchObject({
      name: 'Kestrel', class: 'Operator', background: 'Outlander',
      level: 2, xp: 6, faction: 'Zaibatsu',
    });
  });

  it('brings every attribute, so the derived layer can do its job', () => {
    expect(through(full).mapped).toMatchObject({
      str: 9, dex: 14, con: 10, int: 8, wis: 13, cha: 7,
    });
  });

  it('brings skills by their id rather than their label', () => {
    // The id is their contract; the name is a label. Both match ours today and only one
    // of them is promised to.
    expect(through(full).mapped).toMatchObject({ fix: 1, shoot: 0 });
  });

  it('keeps a rank of zero, which is not the same as untrained', () => {
    expect(through(full).mapped.shoot).toBe(0);
  });

  it('puts species, homeworld and goals somewhere a player will read them', () => {
    // None has a field of its own on this sheet, and dropping them would lose real text.
    expect(through(full).mapped.description).toBe('Species: Human · Homeworld: Kowloon · Goals: Pay the debt');
  });

  it('reports hit points and cash rather than writing them', () => {
    // They are linked fields here - the token and the bank own them - so they come back
    // under `skipped` with a reason instead of looking unrecognised.
    const withLinked = actor({
      system: { health: { value: 6, max: 6 }, credits: { carriedBase: 75 }, baseAc: 13 },
    });
    const { skipped, unmapped, mapped } = through(withLinked);
    // AC is linked too on this sheet - it lives on the token - so all four are reported.
    expect(Object.keys(skipped).sort()).toEqual(['AC', 'Cash', 'HP', 'HPMax']);
    expect(mapped.ac).toBeUndefined();
    expect(Object.keys(unmapped)).toEqual([]);
  });
});

describe('weapons', () => {
  const armed = (system) => through(actor({ items: [{ type: 'weapon', name: 'W', system }] })).mapped;

  it('translates the trauma shape the sheet parses', () => {
    // Theirs is { die: "1d8", rating: 2 }; the resolver reads "d8/x2".
    expect(armed({ trauma: { die: '1d8', rating: 2 } }).weapon1_trauma).toBe('d8/x2');
  });

  it('drops a shock of zero rather than printing a column for a weapon with none', () => {
    // "{ dmg: '0', ac: 10 }" is how they spell "no shock".
    expect(armed({ shock: { dmg: '0', ac: 10 } }).weapon1_shock).toBeUndefined();
    expect(armed({ shock: { dmg: '1', ac: 15 } }).weapon1_shock).toBe('1/15');
  });

  it('collapses a two-attribute weapon the way the book does', () => {
    // A knife is Dex or Str, whichever is better - the sheet stores that as one value.
    expect(armed({ stat: 'dex', secondStat: 'str' }).weapon1_attr).toBe('str_dex');
  });

  it('carries the readied or stowed state across', () => {
    expect(armed({ location: 'readied' }).weapon1_carry).toBe('readied');
    expect(armed({ location: 'stowed' }).weapon1_carry).toBe('stowed');
  });

  it('leaves trauma out when there is no die', () => {
    expect(armed({ trauma: { rating: 2 } }).weapon1_trauma).toBeUndefined();
    expect(armed({}).weapon1_trauma).toBeUndefined();
  });
});

describe('cyberware', () => {
  it('gathers into the rows the sheet keeps, with their words already ours', () => {
    // Head, Sensory, Nerve, Limb, Body and Touch, Medical, Sight, Obvious are the same
    // vocabulary once lowercased, so no translation table exists to drift.
    const { mapped } = through(actor({
      items: [
        { type: 'cyberware', name: 'Cranial Jack', system: { cost: 1000, strain: 0.25, type: 'Head', concealment: 'Touch', effect: 'A socket' } },
        { type: 'cyberware', name: 'Cybereyes', system: { cost: 10000, strain: 0.25, type: 'Sensory', concealment: 'Sight' } },
      ],
    }));
    const rows = cyberware.fromFormFields(mapped);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Cranial Jack', type: 'head', hl: 0.25, cost: 1000, conc: 'touch',
    });
    expect(rows[1]).toMatchObject({ type: 'sensory', conc: 'sight' });
  });

  it('leaves a piece unplaced, because their export says what not where', () => {
    const { mapped } = through(actor({
      items: [{ type: 'cyberware', name: 'Cyberarm', system: { type: 'Limb', strain: 1 } }],
    }));
    expect(cyberware.fromFormFields(mapped)[0].placed).toBe(false);
  });
});

describe('the inventory', () => {
  it('comes across as rows rather than a line', () => {
    // Their names contain commas - "Kit, Cyberdoc" - and the line parser splits on those,
    // so a line would quietly turn one kit into two items.
    const { mapped } = through(actor({
      items: [
        { type: 'item', name: 'Kit, Cyberdoc', system: { quantity: 2, encumbrance: 2, location: 'stowed' } },
        { type: 'item', name: 'Smartphone, Basic', system: { quantity: 1, encumbrance: 0, location: 'stowed' } },
      ],
    }));
    const rows = JSON.parse(mapped.inventory);
    expect(rows.map((r) => r.name)).toEqual(['Kit, Cyberdoc', 'Smartphone, Basic']);
    expect(rows[0]).toMatchObject({ qty: 2, enc: '2', carry: 'stowed' });
  });

  it('files anything that is not readied or stowed as stashed', () => {
    const { mapped } = through(actor({
      items: [{ type: 'item', name: 'Crate', system: { location: 'vault' } }],
    }));
    expect(JSON.parse(mapped.inventory)[0].carry).toBe('stash');
  });

  it('carries a bundle flag across, since the sheet counts bundles', () => {
    const { mapped } = through(actor({
      items: [{ type: 'item', name: 'Grenades', system: { quantity: 3, bundle: { bundled: true } } }],
    }));
    expect(JSON.parse(mapped.inventory)[0].bundled).toBe(true);
  });
});

describe('the prose they carry', () => {
  it('strips the HTML rather than showing markup on a sheet', () => {
    expect(charwn.plain('<p>Twitchy since the surgery</p><br />And worse since.'))
      .toBe('Twitchy since the surgery\nAnd worse since.');
  });

  it('lists foci and edges, saying which is which', () => {
    const { mapped } = through(actor({
      items: [
        { type: 'feature', name: 'Cyberdoc', system: { type: 'focus', level: 1 } },
        { type: 'feature', name: 'Alert', system: { type: 'focus', level: 2 } },
        { type: 'feature', name: 'Wired', system: { type: 'edge', level: 1 } },
      ],
    }));
    expect(mapped.foci_notes).toBe('Focus: Cyberdoc\nFocus: Alert 2\nEdge: Wired');
  });

  it('brings contacts across as readable lines', () => {
    const { mapped } = through(actor({
      items: [{
        type: 'feature', name: 'Contact: jack', system: { type: 'feature' },
        flags: { 'characters-without-number': { contact: { name: 'jack', profession: 'fixer', relationship: 'friend', description: 'Owes me' } } },
      }],
    }));
    expect(mapped.contacts_notes).toBe('jack — fixer — friend — Owes me');
  });
});

describe('an export with almost nothing in it', () => {
  it('produces what little there is rather than throwing', () => {
    const bare = { flags: { 'characters-without-number': {} } };
    expect(charwn.isCharwnExport(bare)).toBe(true);
    expect(() => charwn.toCandidates(bare)).not.toThrow();
    expect(Object.keys(through(bare).unmapped)).toEqual([]);
  });

  it('never writes a field with nothing in it', () => {
    // An import that overwrites a filled-in name with an empty string is worse than one
    // that skips the field.
    const candidates = charwn.toCandidates(actor({ system: { class: '', background: '' } }));
    expect(candidates).not.toHaveProperty('Class');
    expect(candidates).not.toHaveProperty('Background');
  });
});
