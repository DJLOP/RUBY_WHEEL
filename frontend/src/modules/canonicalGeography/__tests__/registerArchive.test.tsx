/**
 * Retired anchors, scopes and connections stay recoverable (WP6 final-review fix), as
 * retired features already are: hidden from the working lists, fetched explicitly for an
 * editor-only archive, restorable through the server's restore route, never deleted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchCanonicalGeography } from '../api';
import type { CanonicalGeographyData } from '../api';
import {
  CITY, anchorRec, connectionRec, dataOf, land, mutations, openTab, path, renderManager, scopeRec, stubFetch, type Call, type Harness,
} from './wp6Fixtures';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

interface Case {
  tab: RegExp;
  entity: 'anchors' | 'scopes' | 'connections';
  label: string;
  activeAttr: string;
  active: { id: number; lifecycle_state: string };
  retired: { id: number; lifecycle_state: string; revision: number };
  data: (restored: boolean) => CanonicalGeographyData;
  identity: RegExp;
}

const activeAnchor = anchorRec(4, { name: 'Arena', anchor_key: 'arena-test' });
const retiredAnchor = anchorRec(5, { name: 'Old Temple', anchor_key: 'old-temple', lifecycle_state: 'retired', revision: 2 });
const activeScope = scopeRec(2, 'district', 1, { name: 'White Gold' });
const retiredScope = scopeRec(3, 'district', 1, { name: 'Old Ward', scope_key: 'old-ward', lifecycle_state: 'retired', revision: 3 });
const activeConn = connectionRec(40, { name: 'Ferry' });
const retiredConn = connectionRec(41, { name: 'Old Bridge', connection_kind: 'bridge', lifecycle_state: 'retired', revision: 1 });
const islands = [land(1, 0), land(2, 20)];

const CASES: Case[] = [
  {
    tab: /ANCHORS/, entity: 'anchors', label: 'anchor', activeAttr: 'data-anchor-id', active: activeAnchor, retired: retiredAnchor,
    identity: /#5 Old Temple \(old-temple\)/,
    data: (restored) => dataOf({ anchors: restored ? [activeAnchor, { ...retiredAnchor, lifecycle_state: 'accepted' }] : [activeAnchor] }),
  },
  {
    tab: /SCOPES/, entity: 'scopes', label: 'scope', activeAttr: 'data-scope-id', active: activeScope, retired: retiredScope,
    identity: /#3 Old Ward \(district, old-ward\)/,
    data: (restored) => dataOf({ scopes: restored ? [CITY, activeScope, { ...retiredScope, lifecycle_state: 'accepted' }] : [CITY, activeScope] }),
  },
  {
    tab: /CONNECTIONS/, entity: 'connections', label: 'connection', activeAttr: 'data-connection-id', active: activeConn, retired: retiredConn,
    identity: /#41 Old Bridge bridge · soft/,
    data: (restored) => dataOf({ features: islands, connections: restored ? [activeConn, { ...retiredConn, lifecycle_state: 'accepted' }] : [activeConn] }),
  },
];

/** A server double: the retired list until restored; restore answers `restoreReply`. */
function server(c: Case, restoreReply: { status: number; body: unknown }) {
  let restored = false;
  h.respond = (call: Call) => {
    const p = path(call);
    if (call.method === 'GET' && p === `/${c.entity}` && call.url.includes('states=retired')) {
      return { status: 200, body: restored ? [] : [c.retired] };
    }
    if (p === `/${c.entity}/${c.retired.id}/restore`) {
      if (restoreReply.status < 400) restored = true;
      return restoreReply;
    }
    if (p === '/anchors/register') {
      const entries = [c.active, ...(restored ? [c.retired] : [])].filter(() => c.entity === 'anchors')
        .map(a => ({ ...a, status: 'unplaced', placed: false, required_scope: null, part_summary: { count: 0, by_role: {}, parts: [] } }));
      return { status: 200, body: { anchors: entries, summary: { total: entries.length, placed: 0, unplaced: entries.length, unplaced_must_exist: [] } } };
    }
    return { status: 200, body: [] };
  };
}

const archive = (c: Case) => screen.getByLabelText(`${c.label} archive`);

describe.each(CASES)('$entity archive', (c) => {
  it('keeps retired records out of the active list, behind a counted archive', async () => {
    server(c, { status: 200, body: {} });
    renderManager(h, c.data(false));
    await openTab(c.tab);
    await waitFor(() => expect(within(archive(c)).getByRole('button', { name: /SHOW RETIRED \/ ARCHIVE \(1\)/ })).toBeInTheDocument());
    expect(document.querySelector(`[${c.activeAttr}="${c.retired.id}"]`)).toBeNull();
    expect(document.querySelector(`[data-archived-id="${c.retired.id}"]`)).toBeNull();
    // Retired rows were read explicitly, editor-only.
    expect(h.calls.some(x => x.method === 'GET' && path(x) === `/${c.entity}` && x.url.includes('states=retired'))).toBe(true);
  });

  it('opens the archive, selects the retired record, and restores it through the restore route', async () => {
    server(c, { status: 200, body: { record: { ...c.retired, lifecycle_state: 'accepted' }, warnings: [] } });
    const { rerenderWith } = renderManager(h, c.data(false));
    await openTab(c.tab);
    await userEvent.click(await within(archive(c)).findByRole('button', { name: /SHOW RETIRED \/ ARCHIVE \(1\)/ }));
    const row = await waitFor(() => {
      const r = document.querySelector(`[data-archived-id="${c.retired.id}"]`);
      expect(r).not.toBeNull();
      return r as HTMLElement;
    });
    expect(row.textContent).toMatch(c.identity);
    await userEvent.click(row);
    const inspector = screen.getByLabelText(`Retired ${c.label}`);
    expect(within(inspector).queryByRole('button', { name: /DELETE/ })).toBeNull();
    await userEvent.click(within(inspector).getByRole('button', { name: 'RESTORE' }));

    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0]).toMatchObject({ method: 'POST', body: undefined });
    expect(path(mutations(h)[0])).toBe(`/${c.entity}/${c.retired.id}/restore`);
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(`${c.label} #${c.retired.id} restored to accepted`);

    // The refetched working set now holds it as accepted; the archive no longer does.
    rerenderWith(c.data(true));
    await openTab(c.tab);
    await waitFor(() => expect(document.querySelector(`[${c.activeAttr}="${c.retired.id}"]`)).not.toBeNull());
    await waitFor(() => expect(within(archive(c)).getByRole('button', { name: /ARCHIVE \(0\)/ })).toBeInTheDocument());
  });

  it('a refused restore shows the server reason and leaves the record archived', async () => {
    server(c, { status: 409, body: { error: `cannot restore ${c.label} #${c.retired.id}: 1 cross-feature violation(s)`,
      violations: [{ code: 'x', message: 'the parent scope is not accepted' }] } });
    renderManager(h, c.data(false));
    await openTab(c.tab);
    await userEvent.click(await within(archive(c)).findByRole('button', { name: /ARCHIVE \(1\)/ }));
    await userEvent.click(await waitFor(() => document.querySelector(`[data-archived-id="${c.retired.id}"]`) as HTMLElement));
    await userEvent.click(within(screen.getByLabelText(`Retired ${c.label}`)).getByRole('button', { name: 'RESTORE' }));
    const refusal = await screen.findByLabelText('Restore refusal');
    expect(refusal.textContent).toMatch(/cannot restore/);
    expect(refusal.textContent).toMatch(/the parent scope is not accepted/);
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot restore/);
    expect(document.querySelector(`[data-archived-id="${c.retired.id}"]`)).not.toBeNull();
    expect(document.querySelector(`[${c.activeAttr}="${c.retired.id}"]`)).toBeNull();
    expect(mutations(h).some(x => x.method === 'DELETE')).toBe(false);
  });
});

describe('normal fetches are unchanged', () => {
  it('the working set asks for accepted, draft and proposed only; the public read asks for accepted only', async () => {
    await fetchCanonicalGeography('tok');
    const working = h.calls.map(c => c.url);
    expect(working).toHaveLength(4);
    for (const u of working) {
      expect(u).toMatch(/states=accepted,draft,proposed&/);
      expect(u).not.toMatch(/retired/);
    }
    h.calls.length = 0;
    await fetchCanonicalGeography(null);
    for (const u of h.calls.map(c => c.url)) {
      expect(u).not.toMatch(/states=/);
      expect(u).not.toMatch(/retired/);
    }
  });
});
