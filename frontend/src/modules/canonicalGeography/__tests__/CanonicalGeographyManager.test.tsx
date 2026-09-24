/**
 * The WP4 manager shell: counts by lifecycle state and the overlay toggle — and nothing
 * that could change canon. Tracing, lifecycle actions and the registers are WP5–WP7.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanonicalGeographyManager } from '../CanonicalGeographyManager';
import type { CanonicalGeographyData } from '../api';

const rec = (id: number, lifecycle_state: string) => ({ id, lifecycle_state }) as any;

const data = (over: Partial<CanonicalGeographyData> = {}): CanonicalGeographyData => ({
  features: [rec(1, 'accepted'), rec(2, 'accepted'), rec(3, 'draft'), rec(4, 'proposed')],
  anchors: [rec(1, 'accepted')],
  connections: [],
  scopes: [rec(1, 'accepted')],
  includesWorkingSet: true,
  ...over,
});

describe('CanonicalGeographyManager (shell)', () => {
  it('counts what the scene draws by lifecycle state', () => {
    const { container } = render(<CanonicalGeographyManager data={data()} overlayVisible onToggleOverlay={vi.fn()} onClose={vi.fn()} />);
    const cells = (row: string) => [...container.querySelector(`[data-row="${row}"]`)!.querySelectorAll('td')].map(td => td.textContent);
    expect(cells('FEATURES')).toEqual(['FEATURES', '2', '1', '1']);
    expect(cells('SCOPES')).toEqual(['SCOPES', '1', '0', '0']);
  });

  it('does not claim zero drafts when the working set was not loaded', () => {
    const { container } = render(<CanonicalGeographyManager data={data({ includesWorkingSet: false })} overlayVisible onToggleOverlay={vi.fn()} onClose={vi.fn()} />);
    const row = container.querySelector('[data-row="FEATURES"]') as HTMLElement;
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('toggles the overlay and closes', async () => {
    const onToggleOverlay = vi.fn();
    const onClose = vi.fn();
    render(<CanonicalGeographyManager data={data()} overlayVisible={false} onToggleOverlay={onToggleOverlay} onClose={onClose} />);
    const toggle = screen.getByLabelText('Show canonical overlay') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await userEvent.click(toggle);
    expect(onToggleOverlay).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByLabelText('Close canonical geography'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers no action that could change canon', () => {
    render(<CanonicalGeographyManager data={data()} overlayVisible onToggleOverlay={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Close canonical geography']);
    expect(screen.queryByText(/accept|retire|revise|lock|import/i, { selector: 'button' })).toBeNull();
  });
});
