import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SheetRenderer } from '../SheetRenderer';
import { citiesWithoutNumber } from '../../sheets/templates/cities_without_number';
import { cyberpunkRed } from '../../sheets/templates/cyberpunk_red';
import { PLUG_FIELD, PLUG_LOCKED_FIELD } from '../../sheets/cwnSkillplugs';

/**
 * Skillplugs, in the three places a player meets them.
 *
 * LOAD on the inventory row the plug is carried in - Readied only, because loading is a
 * Main Action and reaching a Stowed item is another. The granted skill on the SKILLS tab,
 * because a sheet reading 0 for a skill that rolls at 1 makes the plug look broken. And
 * what is loaded in the header, where it follows the player onto every tab.
 *
 * The rules are in sheets/__tests__/cwnSkillplugs.test.ts and the roll wiring in
 * backend/__tests__/cwn_skillplugs_sockets.test.js.
 */

const jack = (name = 'Skillplug Jack II') => [{ name, type: 'head', placed: true, equipped: true }];

const kit = (...rows: { name: string; carry?: string }[]) =>
  JSON.stringify(rows.map((r) => ({
    qty: 1, enc: '', bundled: false, carry: 'readied', location: '', ...r,
  })));

const show = (data: Record<string, unknown>, template = citiesWithoutNumber) => {
  const onFieldChange = vi.fn();
  const onFieldsChange = vi.fn();
  render(
    <SheetRenderer
      template={template} data={data as never} readOnly={false}
      onFieldChange={onFieldChange} onFieldsChange={onFieldsChange}
    />,
  );
  return { onFieldChange, onFieldsChange };
};

const tab = (name: string) => userEvent.click(screen.getByRole('button', { name }));

describe('LOAD on the row the plug is carried in', () => {
  it('is offered for a plug', async () => {
    show({ cyberware: jack(), inventory: kit({ name: 'Skillplug: Fix-1' }) });
    await tab('GEAR');
    expect(screen.getByRole('button', { name: 'LOAD Skillplug: Fix-1' })).toBeEnabled();
  });

  it('is not offered for an ordinary item', async () => {
    show({ cyberware: jack(), inventory: kit({ name: 'Rope' }) });
    await tab('GEAR');
    expect(screen.queryByRole('button', { name: /LOAD/ })).not.toBeInTheDocument();
  });

  it('sits beside CONSUME without either knowing about the other', async () => {
    // One row is a drug, the next is a plug. Each gets its own button.
    show({
      cyberware: jack(),
      inventory: kit({ name: 'Boneshaker' }, { name: 'Skillplug: Fix-1' }),
    });
    await tab('GEAR');
    expect(screen.getByRole('button', { name: 'CONSUME Boneshaker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LOAD Skillplug: Fix-1' })).toBeInTheDocument();
  });

  it('is disabled with no jack, and says so', async () => {
    show({ inventory: kit({ name: 'Skillplug: Fix-1' }) });
    await tab('GEAR');
    const btn = screen.getByRole('button', { name: 'LOAD Skillplug: Fix-1' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('No skillplug jack'));
  });

  it('is disabled while the plug is only Stowed', async () => {
    show({ cyberware: jack(), inventory: kit({ name: 'Skillplug: Fix-1', carry: 'stowed' }) });
    await tab('GEAR');
    expect(screen.getByRole('button', { name: 'LOAD Skillplug: Fix-1' }))
      .toHaveAttribute('title', expect.stringContaining('Ready it first'));
  });

  it('explains a Jack I refusing a physical plug', async () => {
    // The classification is ours, not the book's, so it explains rather than hiding.
    show({
      cyberware: jack('Skillplug Jack I'),
      inventory: kit({ name: 'Skillplug: Shoot-1' }),
    });
    await tab('GEAR');
    expect(screen.getByRole('button', { name: 'LOAD Skillplug: Shoot-1' }))
      .toHaveAttribute('title', expect.stringContaining('intellectual'));
  });

  it('loads the plug without spending the row', async () => {
    // A plug is a cylinder you slot, not a dose you use up.
    const { onFieldsChange } = show({
      cyberware: jack(), inventory: kit({ name: 'Skillplug: Fix-1' }),
    });
    await tab('GEAR');
    await userEvent.click(screen.getByRole('button', { name: 'LOAD Skillplug: Fix-1' }));
    const written = onFieldsChange.mock.calls[0][0];
    expect(JSON.parse(written[PLUG_FIELD] as string)).toEqual([{ skill: 'fix', level: 1 }]);
    expect(written).not.toHaveProperty('inventory');
  });

  it('does not appear on Cyberpunk RED', async () => {
    show({ cyberware: jack(), inventory: kit({ name: 'Skillplug: Fix-1' }) }, cyberpunkRed);
    await tab('GEAR');
    expect(screen.queryByRole('button', { name: /LOAD/ })).not.toBeInTheDocument();
  });
});

describe('the granted skill on the SKILLS tab', () => {
  it('shows the level the plug grants, not the one on the sheet', async () => {
    // The server resolves the roll with the plug counted, so a sheet reading 0 for a skill
    // that rolls at 1 would make the plug look broken.
    show({ cyberware: jack(), fix: 0, int_mod: 0, [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] });
    await tab('SKILLS');
    const row = screen.getByText(/^Fix/).closest('div')!;
    expect(row.textContent).toContain('Fix');
    expect(screen.getByTitle(/granted at level-1/)).toBeInTheDocument();
  });

  it('marks nothing on a skill with no plug', async () => {
    show({ cyberware: jack(), fix: 1 });
    await tab('SKILLS');
    expect(screen.queryByTitle(/granted at level/)).not.toBeInTheDocument();
  });

  it('marks nothing while the jack is down', async () => {
    show({
      cyberware: jack(), fix: 0,
      [PLUG_FIELD]: [{ skill: 'fix', level: 1 }], [PLUG_LOCKED_FIELD]: true,
    });
    await tab('SKILLS');
    expect(screen.queryByTitle(/granted at level/)).not.toBeInTheDocument();
  });
});

describe('what is loaded follows you across the tabs', () => {
  it('shows nothing with no plugs in', () => {
    show({ cyberware: jack() });
    expect(screen.queryByText(/FIX-1/)).not.toBeInTheDocument();
  });

  it('is in the header, before any tab is chosen', () => {
    show({ cyberware: jack(), [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] });
    expect(screen.getByText(/FIX-1/)).toBeInTheDocument();
  });

  it('unloads without returning anything to the inventory', async () => {
    const { onFieldsChange } = show({
      cyberware: jack(), [PLUG_FIELD]: [{ skill: 'fix', level: 1 }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Unload fix' }));
    const written = onFieldsChange.mock.calls[0][0];
    expect(JSON.parse(written[PLUG_FIELD] as string)).toEqual([]);
    expect(written).not.toHaveProperty('inventory');
  });

  it('says how wide the crash band has got once more than one is in', () => {
    // The book's neural crosstalk. Two plugs crash a check on 3 or less.
    show({
      cyberware: jack(),
      [PLUG_FIELD]: [{ skill: 'fix', level: 1 }, { skill: 'know', level: 1 }],
    });
    expect(screen.getByText(/checks crash on 3 or less, attacks on 2/)).toBeInTheDocument();
  });

  it('stays quiet about the band with a single plug', () => {
    show({ cyberware: jack(), [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] });
    expect(screen.queryByText(/checks crash on/)).not.toBeInTheDocument();
  });
});

describe('a crashed jack', () => {
  const crashed = {
    cyberware: jack(), fix: 0,
    [PLUG_FIELD]: [{ skill: 'fix', level: 1 }], [PLUG_LOCKED_FIELD]: true,
  };

  it('says so in the header, because nothing else on the sheet would', () => {
    show(crashed);
    expect(screen.getByText('PLUG JACK DOWN')).toBeInTheDocument();
  });

  it('hides what was loaded, since it is granting nothing', () => {
    show(crashed);
    expect(screen.queryByText(/FIX-1/)).not.toBeInTheDocument();
  });

  it('comes back with a reboot, and the plug works again', async () => {
    const { onFieldsChange } = show(crashed);
    await userEvent.click(screen.getByRole('button', { name: 'REBOOT JACK' }));
    expect(onFieldsChange).toHaveBeenCalledWith({ [PLUG_LOCKED_FIELD]: '' });
  });

  it('says nothing on a character who never crashed', () => {
    show({ cyberware: jack(), [PLUG_FIELD]: [{ skill: 'fix', level: 1 }] });
    expect(screen.queryByText('PLUG JACK DOWN')).not.toBeInTheDocument();
  });
});
