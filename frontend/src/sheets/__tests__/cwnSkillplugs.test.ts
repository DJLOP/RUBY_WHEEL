import { describe, it, expect } from 'vitest';
import {
  PLUG_FIELD, PLUG_LOCKED_FIELD, INTELLECTUAL, isIntellectual, plugPrice, jackOf,
  loaded, running, isLocked, effectiveSkill, failureBand, loadable, loadFromRow, unload,
  plugFromName, plugItemName, hasSkillplugs,
} from '../cwnSkillplugs';

/**
 * The mirror, and the controls the sheet draws.
 *
 * The first block is why mirroring is safe: it walks both copies over the same sheets, so
 * a rule edited on one side and not the other fails here rather than in somebody's game.
 * The server decides the rolls; this side only has to agree with it.
 */

const jack = (name = 'Skillplug Jack II') => [{ name, type: 'head', placed: true, equipped: true }];

const rig = (over: Record<string, unknown> = {}) => ({
  cyberware: jack(), [PLUG_FIELD]: [], ...over,
});

describe('the mirror agrees with the server', () => {
  it('reads the same fields and the same classification', async () => {
    const backend = await import('../../../../backend/sheets/cwnSkillplugs.js');
    expect(PLUG_FIELD).toBe(backend.FIELD);
    expect(PLUG_LOCKED_FIELD).toBe(backend.LOCKED_FIELD);
    expect([...INTELLECTUAL].sort()).toEqual([...backend.INTELLECTUAL].sort());
  });

  it('decides the same things about the same sheets', async () => {
    const backend = await import('../../../../backend/sheets/cwnSkillplugs.js');
    const shapes = [
      rig(),
      rig({ cyberware: [] }),
      rig({ [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] }),
      rig({ cyberware: jack('Skillplug Jack I'), [PLUG_FIELD]: [{ skill: 'shoot', level: 1 }] }),
      rig({ cyberware: jack('Skillplug Jack I'), [PLUG_FIELD]: [{ skill: 'know', level: 1 }] }),
      rig({ [PLUG_FIELD]: [{ skill: 'know', level: 2 }] }),
      rig({ cyberware: [...jack(), { name: 'Skillplug Wiring', placed: true, equipped: true }],
        [PLUG_FIELD]: [{ skill: 'know', level: 3 }] }),
      rig({ fix: 2, [PLUG_FIELD]: [{ skill: 'fix', level: 0 }] }),
      rig({ [PLUG_FIELD]: [{ skill: 'fix', level: 1 }], [PLUG_LOCKED_FIELD]: true }),
      rig({ [PLUG_FIELD]: [{ skill: 'fix', level: 1 }, { skill: 'know', level: 1 }] }),
      rig({ [PLUG_FIELD]: 'nonsense' }),
      rig({ [PLUG_FIELD]: [{ level: 1 }] }),
    ];
    for (const data of shapes) {
      const label = JSON.stringify(data);
      expect(running(data as never).map((p) => p.skill).sort(), label)
        .toEqual(backend.running(data).map((p: { skill: string }) => p.skill).sort());
      expect(failureBand(data as never, 'skill'), label).toBe(backend.failureBand(data, 'skill'));
      expect(failureBand(data as never, 'attack'), label).toBe(backend.failureBand(data, 'attack'));
      expect(effectiveSkill(data as never, 'fix'), label).toBe(backend.effectiveSkill(data, 'fix'));
      expect(isLocked(data as never), label).toBe(backend.isLocked(data));
      expect(jackOf(data as never), label).toEqual(backend.jackOf(data));
    }
  });

  it('prices plugs the same way', async () => {
    const backend = await import('../../../../backend/sheets/cwnSkillplugs.js');
    for (const level of [0, 1, 2, 3]) {
      for (const skill of ['know', 'shoot']) {
        expect(plugPrice(level, skill), `${skill}-${level}`).toBe(backend.plugPrice(level, skill));
      }
    }
  });
});

describe('a plug is carried like anything else', () => {
  it('reads one off an inventory row name', () => {
    expect(plugFromName('Skillplug: Fix-1')).toEqual({ skill: 'fix', level: 1 });
    expect(plugFromName('plug shoot 0')).toEqual({ skill: 'shoot', level: 0 });
  });

  it('reads a two-word skill', () => {
    expect(plugFromName('Skillplug: cast skill-2')).toEqual({ skill: 'cast_skill', level: 2 });
  });

  it('is not fooled by an ordinary item', () => {
    for (const name of ['Rope', 'Boneshaker', 'Plugs of wisdom', '']) {
      expect(plugFromName(name), name).toBeNull();
    }
  });

  it('round-trips through the name the shop would give it', () => {
    const plug = { skill: 'fix', level: 1 };
    expect(plugFromName(plugItemName(plug))).toEqual(plug);
  });
});

describe('whether a row can be loaded', () => {
  const row = (over: Partial<{ name: string; carry: string }> = {}) => ({
    name: 'Skillplug: Fix-1', qty: 1, enc: '', bundled: false,
    carry: 'readied', location: '', ...over,
  }) as never;

  it('loads a readied plug through a jack that can carry it', () => {
    expect(loadable(rig() as never, row()).ok).toBe(true);
  });

  it('says so when there is no jack at all', () => {
    const out = loadable(rig({ cyberware: [] }) as never, row());
    expect(out.ok).toBe(false);
    expect(out.why).toContain('No skillplug jack');
  });

  it('needs the plug readied, like a dose', () => {
    const out = loadable(rig() as never, row({ carry: 'stowed' }));
    expect(out.ok).toBe(false);
    expect(out.why).toContain('Ready it first');
  });

  it('explains a Jack I refusing a physical plug rather than hiding it', () => {
    // The classification is ours, so the sheet says so instead of silently dropping.
    const out = loadable(
      rig({ cyberware: jack('Skillplug Jack I') }) as never, row({ name: 'Skillplug: Shoot-1' }),
    );
    expect(out.ok).toBe(false);
    expect(out.why).toContain('intellectual');
  });

  it('explains a level the jack cannot reach', () => {
    const out = loadable(rig() as never, row({ name: 'Skillplug: Know-2' }));
    expect(out.ok).toBe(false);
    expect(out.why).toContain('Wiring');
  });

  it('refuses while the jack is down', () => {
    const out = loadable(rig({ [PLUG_LOCKED_FIELD]: true }) as never, row());
    expect(out.ok).toBe(false);
    expect(out.why).toContain('crashed');
  });

  it('will not load a plug no better than one already in', () => {
    const out = loadable(rig({ [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] }) as never, row());
    expect(out.ok).toBe(false);
    expect(out.why).toContain('Already running');
  });

  it('ignores a row that is not a plug', () => {
    expect(loadable(rig() as never, row({ name: 'Rope' })).plug).toBeNull();
  });
});

describe('loading and unloading', () => {
  const kit = (name: string) => JSON.stringify([
    { name, qty: 1, enc: '', bundled: false, carry: 'readied', location: '' },
  ]);

  it('starts the plug running', () => {
    const data = rig({ inventory: kit('Skillplug: Fix-1') });
    const written = loadFromRow(data as never, 0)!;
    expect(JSON.parse(written[PLUG_FIELD] as string)).toEqual([{ skill: 'fix', level: 1 }]);
  });

  it('does not spend the row, because a plug is not a dose', () => {
    // You slot a cylinder and can pull it back out. Nothing is consumed.
    const data = rig({ inventory: kit('Skillplug: Fix-1') });
    expect(loadFromRow(data as never, 0)).not.toHaveProperty('inventory');
  });

  it('replaces a weaker plug for the same skill rather than stacking two', () => {
    const data = rig({
      inventory: kit('Skillplug: Fix-1'), [PLUG_FIELD]: [{ skill: 'fix', level: 0 }],
    });
    expect(JSON.parse(loadFromRow(data as never, 0)![PLUG_FIELD] as string))
      .toEqual([{ skill: 'fix', level: 1 }]);
  });

  it('pulls one out without touching the others', () => {
    const data = rig({ [PLUG_FIELD]: [{ skill: 'fix', level: 1 }, { skill: 'know', level: 1 }] });
    expect(JSON.parse(unload(data as never, 'fix')[PLUG_FIELD] as string))
      .toEqual([{ skill: 'know', level: 1 }]);
  });

  it('refuses a row it cannot load', () => {
    const data = rig({ cyberware: [], inventory: kit('Skillplug: Fix-1') });
    expect(loadFromRow(data as never, 0)).toBeNull();
  });
});

describe('system isolation', () => {
  it('is Cities Without Number only', () => {
    expect(hasSkillplugs('cities_without_number')).toBe(true);
    expect(hasSkillplugs('cyberpunk_red')).toBe(false);
    expect(hasSkillplugs(null)).toBe(false);
  });

  it('agrees with the book on all six examples it gives', () => {
    for (const yes of ['know', 'fix', 'heal']) expect(isIntellectual(yes), yes).toBe(true);
    for (const no of ['shoot', 'exert', 'perform']) expect(isIntellectual(no), no).toBe(false);
  });
});
