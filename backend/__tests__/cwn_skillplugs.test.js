import { describe, it, expect } from 'vitest';

const plugs = require('../sheets/cwnSkillplugs');
const { CWN_SKILLS } = require('../sheets/rolls');

/**
 * Skillplugs (p64).
 *
 * Two halves. What a plug GRANTS, which is the overlay-on-read shape the chrome and the
 * drugs already use - slot it and the skill is there, unslot it and it is exactly as it
 * was. And what a plug COSTS, which is the part the app enforces: the worst the dice can
 * do becomes an automatic failure, and each extra plug widens that band.
 */

const chrome = (...names) => names.map((name) => ({
  name, type: 'head', placed: true, equipped: true,
}));

/** A character with a jack, some plugs, and whatever skills they earned themselves. */
const rig = ({ jack = ['Skillplug Jack II'], slots = [], ...rest } = {}) => ({
  cyberware: chrome(...jack),
  [plugs.FIELD]: slots,
  ...rest,
});

describe('the hardware decides what you can run', () => {
  it('grants nothing without a jack', () => {
    expect(plugs.running(rig({ jack: [], slots: [{ skill: 'know', level: 1 }] }))).toEqual([]);
  });

  it('reads the jack off installed chrome, not off what you merely own', () => {
    const owned = {
      cyberware: [{ name: 'Skillplug Jack II', placed: false, equipped: true }],
      [plugs.FIELD]: [{ skill: 'shoot', level: 1 }],
    };
    // A jack in a box on the table interfaces with nothing.
    expect(plugs.running(owned)).toEqual([]);
  });

  it('lets a Jack I carry intellectual plugs only', () => {
    const jack = ['Skillplug Jack I'];
    expect(plugs.running(rig({ jack, slots: [{ skill: 'know', level: 1 }] }))).toHaveLength(1);
    // The book's own counter-example: Shoot needs the upgraded unit.
    expect(plugs.running(rig({ jack, slots: [{ skill: 'shoot', level: 1 }] }))).toHaveLength(0);
  });

  it('lets a Jack II carry anything', () => {
    expect(plugs.running(rig({ slots: [{ skill: 'shoot', level: 1 }] }))).toHaveLength(1);
  });

  it('caps at level-1 without the Wiring', () => {
    expect(plugs.running(rig({ slots: [{ skill: 'know', level: 2 }] }))).toHaveLength(0);
  });

  it('reaches level-3 with the Wiring', () => {
    const jack = ['Skillplug Jack II', 'Skillplug Wiring'];
    expect(plugs.running(rig({ jack, slots: [{ skill: 'know', level: 3 }] }))).toHaveLength(1);
  });

  it('drops a plug the jack cannot run rather than running it lower', () => {
    // A Jack I cannot run a level-2 plug at level 1. It cannot run it.
    const out = plugs.running(rig({ jack: ['Skillplug Jack I'], slots: [{ skill: 'know', level: 2 }] }));
    expect(out).toEqual([]);
  });

  it('takes the better jack when both are installed', () => {
    const jack = ['Skillplug Jack I', 'Skillplug Jack II'];
    expect(plugs.jackOf(rig({ jack })).allowsPhysical).toBe(true);
  });
});

describe('what a plug grants', () => {
  it('gives a skill the character does not have', () => {
    const data = rig({ slots: [{ skill: 'fix', level: 1 }] });
    expect(plugs.effectiveSkill(data, 'fix')).toBe(1);
  });

  it('takes the better of the plug and what you earned', () => {
    // A plug is a facsimile of expertise, not a lobotomy: a level-0 plug must not drag a
    // Fix-2 character down to zero.
    expect(plugs.effectiveSkill(rig({ fix: 2, slots: [{ skill: 'fix', level: 0 }] }), 'fix')).toBe(2);
    expect(plugs.effectiveSkill(rig({ fix: 0, slots: [{ skill: 'fix', level: 1 }] }), 'fix')).toBe(1);
  });

  it('leaves every other skill alone', () => {
    const data = rig({ shoot: 1, slots: [{ skill: 'fix', level: 1 }] });
    expect(plugs.effectiveSkill(data, 'shoot')).toBe(1);
  });

  it('overlays onto the sheet the dice see, without touching the original', () => {
    const data = rig({ fix: 0, slots: [{ skill: 'fix', level: 1 }] });
    expect(plugs.withPlugs(data).fix).toBe(1);
    // Applied on read: unslotting has to give the skill back exactly as it was.
    expect(data.fix).toBe(0);
  });

  it('hands back the same object when nothing is running', () => {
    const data = rig({ jack: [] });
    expect(plugs.withPlugs(data)).toBe(data);
  });

  it('keeps only the better of two plugs for one skill', () => {
    const data = rig({ slots: [{ skill: 'fix', level: 0 }, { skill: 'fix', level: 1 }] });
    expect(plugs.loaded(data)).toHaveLength(1);
    expect(plugs.effectiveSkill(data, 'fix')).toBe(1);
  });
});

describe('the automatic failure band', () => {
  const band = (n, shape) => plugs.failureBand(
    rig({ slots: Array.from({ length: n }, (_, i) => ({ skill: ['fix', 'know', 'talk', 'work'][i], level: 1 })) }),
    shape,
  );

  it('is nothing at all with no plugs running', () => {
    expect(plugs.failureBand(rig({ jack: [] }), 'skill')).toBe(0);
    expect(plugs.crashes(rig({ jack: [] }), 'skill', 2)).toBe(false);
  });

  it('is a natural 2 on a skill check with one plug', () => {
    expect(band(1, 'skill')).toBe(2);
  });

  it('is a natural 1 on an attack with one plug', () => {
    expect(band(1, 'attack')).toBe(1);
  });

  it('widens by one for each plug past the first', () => {
    // "Each additional skillplug run after the first increases the automatic failure roll
    // range by one point."
    expect([band(1, 'skill'), band(2, 'skill'), band(3, 'skill')]).toEqual([2, 3, 4]);
    expect([band(1, 'attack'), band(2, 'attack'), band(3, 'attack')]).toEqual([1, 2, 3]);
  });

  it('crashes on the band and not above it', () => {
    const two = rig({ slots: [{ skill: 'fix', level: 1 }, { skill: 'know', level: 1 }] });
    expect(plugs.crashes(two, 'skill', 3)).toBe(true);
    expect(plugs.crashes(two, 'skill', 4)).toBe(false);
  });

  it('ignores modifiers entirely, which is the whole point', () => {
    // A Fix-3 character with INT +2 rolls snake eyes for a total of 7, which would beat a
    // difficulty 6. Plugged in, it fails anyway - expertise you did not earn fails in a
    // way skill cannot rescue.
    const data = rig({ fix: 3, int_mod: 2, slots: [{ skill: 'fix', level: 1 }] });
    expect(plugs.crashes(data, 'skill', 2)).toBe(true);
  });

  it('counts only plugs the jack can actually run', () => {
    // Three loaded but a Jack I runs one of them, so the band is a single plug's.
    const data = rig({
      jack: ['Skillplug Jack I'],
      slots: [{ skill: 'know', level: 1 }, { skill: 'shoot', level: 1 }, { skill: 'exert', level: 1 }],
    });
    expect(plugs.failureBand(data, 'skill')).toBe(2);
  });
});

describe('a crashed jack', () => {
  const crashed = rig({ fix: 0, slots: [{ skill: 'fix', level: 1 }], [plugs.LOCKED_FIELD]: true });

  it('runs nothing while it is locked', () => {
    expect(plugs.running(crashed)).toEqual([]);
  });

  it('takes the granted skill with it', () => {
    // "The skillplug jack itself then locks up uselessly for the scene" - which means the
    // expertise goes too, not just the risk.
    expect(plugs.effectiveSkill(crashed, 'fix')).toBe(0);
  });

  it('cannot crash again while it is already down', () => {
    expect(plugs.crashes(crashed, 'skill', 2)).toBe(false);
  });

  it('keeps what is loaded, so the scene ending brings it back', () => {
    expect(plugs.loaded(crashed)).toHaveLength(1);
  });
});

describe('reading the natural dice off a roll', () => {
  it('sums the two d6 of a skill check', () => {
    expect(plugs.naturalOf({ rolls: { 6: [1, 1] } }, 'skill')).toBe(2);
    expect(plugs.naturalOf({ rolls: { 6: [3, 4] } }, 'skill')).toBe(7);
  });

  it('takes the face of the d20 on an attack', () => {
    expect(plugs.naturalOf({ rolls: { 20: [1] } }, 'attack')).toBe(1);
    expect(plugs.naturalOf({ rolls: { 20: [17] } }, 'attack')).toBe(17);
  });

  it('reads nothing out of a roll that has neither', () => {
    expect(plugs.naturalOf({ rolls: {} }, 'skill')).toBe(0);
    expect(plugs.naturalOf({}, 'attack')).toBe(0);
  });
});

describe('what a plug costs', () => {
  it('prices the book table for an intellectual skill', () => {
    expect(plugs.plugPrice(0, 'know')).toBe(1000);
    expect(plugs.plugPrice(1, 'know')).toBe(10000);
    expect(plugs.plugPrice(2, 'know')).toBe(50000);
  });

  it('doubles a physical-based skill', () => {
    expect(plugs.plugPrice(1, 'shoot')).toBe(20000);
  });

  it('will not price a level-3 plug, which the book marks N/A', () => {
    // Vanishingly rare, and rumoured to need an expert's neural tissue. Not something you
    // walk in and buy.
    expect(plugs.plugPrice(3, 'know')).toBeNull();
  });
});

describe('the classification is ours, and complete', () => {
  it('matches the book on all six examples it gives', () => {
    for (const yes of ['know', 'fix', 'heal']) expect(plugs.isIntellectual(yes), yes).toBe(true);
    for (const no of ['shoot', 'exert', 'perform']) expect(plugs.isIntellectual(no), no).toBe(false);
  });

  it('has an answer for every skill in the game', () => {
    // A skill the classification forgot would silently read as physical and need a Jack II.
    const missing = Object.keys(CWN_SKILLS).filter(
      (id) => !plugs.INTELLECTUAL.has(id) && !['drive', 'exert', 'perform', 'punch', 'shoot', 'sneak', 'stab'].includes(id),
    );
    expect(missing).toEqual([]);
  });
});

describe('a sheet somebody hand-edited', () => {
  it('survives broken JSON', () => {
    expect(plugs.loaded({ [plugs.FIELD]: '[' })).toEqual([]);
    expect(plugs.loaded({ [plugs.FIELD]: 42 })).toEqual([]);
    expect(plugs.loaded(null)).toEqual([]);
  });

  it('drops a plug with no skill named', () => {
    expect(plugs.loaded({ [plugs.FIELD]: [{ level: 1 }] })).toEqual([]);
  });

  it('clamps a level nobody could have', () => {
    expect(plugs.normalisePlug({ skill: 'fix', level: 9 }).level).toBe(3);
    expect(plugs.normalisePlug({ skill: 'fix', level: -4 }).level).toBe(0);
  });
});
