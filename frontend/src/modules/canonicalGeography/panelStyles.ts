import type { CSSProperties } from 'react';
import type { LifecycleState } from './types';

/** Shared look of the WP6 register panels (kept apart from the components for fast refresh). */

export const fieldStyle: CSSProperties = {
  width: '100%', background: '#111', color: 'var(--green)', border: '1px solid var(--dark-green)', padding: '3px', fontSize: '0.7rem',
};
export const labelStyle: CSSProperties = { fontSize: '0.6rem', opacity: 0.75, display: 'block', marginTop: '5px' };
export const smallBtn: CSSProperties = { fontSize: '0.62rem', padding: '2px 6px', marginRight: '4px', marginTop: '4px' };
export const section: CSSProperties = { borderTop: '1px solid var(--dark-green)', marginTop: '8px', paddingTop: '6px' };
export const kv: CSSProperties = { display: 'grid', gridTemplateColumns: '42% 58%', fontSize: '0.65rem', rowGap: '1px' };
export const listStyle: CSSProperties = { listStyle: 'none', padding: 0, margin: '4px 0 0', maxHeight: '180px', overflowY: 'auto', fontSize: '0.65rem' };
export const confirmFrame: CSSProperties = { border: '1px solid #ffcc55', padding: '6px', marginTop: '8px', fontSize: '0.65rem' };

export const STATE_LABEL: Record<LifecycleState, string> = { accepted: 'ACCEPTED', draft: 'DRAFT', proposed: 'PROPOSED · generated', retired: 'RETIRED' };
