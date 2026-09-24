import type { CanonicalGeographyData } from './api';
import type { LifecycleState } from './types';

/**
 * The primary administrator's canonical-geography panel — a shell in WP4.
 *
 * It shows what the scene is drawing (counts by lifecycle state) and holds the overlay
 * visibility toggle, so canon can be compared against the reference evidence beneath it.
 * Tracing, the feature list and inspector, lifecycle actions, the anchor register, scopes,
 * connections and import arrive in WP5–WP7; nothing here changes canon.
 *
 * Opened only for the primary admin; the server enforces the same boundary on every
 * mutation, so this is which panel is drawn, not who may change the city.
 */
export function CanonicalGeographyManager({
  data, overlayVisible, onToggleOverlay, onClose,
}: {
  data: CanonicalGeographyData;
  overlayVisible: boolean;
  onToggleOverlay: () => void;
  onClose: () => void;
}) {
  const count = (list: { lifecycle_state: LifecycleState }[], state: LifecycleState) =>
    list.filter(r => r.lifecycle_state === state).length;
  const rows: [string, { lifecycle_state: LifecycleState }[]][] = [
    ['FEATURES', data.features], ['ANCHORS', data.anchors], ['CONNECTIONS', data.connections], ['SCOPES', data.scopes],
  ];

  return (
    <div className="panel canonical-geography-manager" role="dialog" aria-label="Canonical geography"
      style={{ position: 'absolute', top: '80px', right: '20px', width: '320px', zIndex: 1500, padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>CANONICAL_GEOGRAPHY</h3>
        <button className="utility-btn" onClick={onClose} aria-label="Close canonical geography">X</button>
      </div>

      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', fontSize: '0.8rem' }}>
        <input type="checkbox" checked={overlayVisible} onChange={onToggleOverlay} aria-label="Show canonical overlay" />
        SHOW_CANONICAL_OVERLAY
      </label>

      <table style={{ width: '100%', marginTop: '10px', fontSize: '0.75rem' }}>
        <thead>
          <tr><th style={{ textAlign: 'left' }}></th><th>ACCEPTED</th><th>DRAFT</th><th>PROPOSED</th></tr>
        </thead>
        <tbody>
          {rows.map(([label, list]) => (
            <tr key={label} data-row={label}>
              <td>{label}</td>
              <td style={{ textAlign: 'center' }}>{count(list, 'accepted')}</td>
              <td style={{ textAlign: 'center' }}>{data.includesWorkingSet ? count(list, 'draft') : '—'}</td>
              <td style={{ textAlign: 'center' }}>{data.includesWorkingSet ? count(list, 'proposed') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ fontSize: '0.7rem', opacity: 0.75, marginTop: '10px' }}>
        Solid = accepted canon. Dashed + DRAFT = editor draft. Magenta dashed + PROPOSED = software proposal
        awaiting review. Drafts and proposals are never generator input.
      </p>
      <p style={{ fontSize: '0.7rem', opacity: 0.75 }}>
        Tracing, editing and acceptance are not available yet.
      </p>
    </div>
  );
}
