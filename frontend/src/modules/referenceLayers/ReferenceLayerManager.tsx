import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReferenceAsset, ReferenceLayer } from './types';
import { planeDimensions } from './calibration';
import {
  ACCEPTED_SOURCE_TYPES,
  changedFields,
  draftFromLayer,
  previewFromDraft,
  toRadians,
  validateSourceFile,
  type ReferenceLayerDraft,
  type ReferenceLayerPreview,
} from './preview';

/**
 * The import → calibrate → display → lock workflow, in one place.
 *
 * It lives here rather than in AdminPanel, which is already long enough to be difficult to
 * change safely. AdminPanel gets one button.
 *
 * Canonical state stays in the map-data hook: this never holds the authoritative list. It
 * holds a draft of the layer being edited, which drives a local preview only, until Apply
 * sends one request and the refreshed canonical list replaces it. A failed request keeps
 * the draft and the preview, because losing somebody's calibration to a network error is
 * worse than showing them an error over their own unsaved numbers.
 */

interface Props {
  token: string;
  layers: ReferenceLayer[];
  /** Refetch the canonical collection after a committed change. */
  refreshLayers: () => void;
  /** Local-only preview for this client's scene. Null clears it. */
  onPreviewChange: (preview: ReferenceLayerPreview | null) => void;
  onClose: () => void;
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The server's own message where there is one, because it is the specific one. */
const errorFrom = async (res: Response, fallback: string) => {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch { /* not JSON */ }
  return fallback;
};

const fieldStyle: React.CSSProperties = {
  width: '100%', background: '#111', color: 'var(--green)',
  border: '1px solid var(--dark-green)', padding: '4px', fontSize: '0.7rem',
};
const labelStyle: React.CSSProperties = { fontSize: '0.6rem', opacity: 0.75, display: 'block', marginTop: '6px' };

export function ReferenceLayerManager({ token, layers, refreshLayers, onPreviewChange, onClose }: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ReferenceLayerDraft | null>(null);
  const [assets, setAssets] = useState<ReferenceAsset[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScale, setNewScale] = useState('1');
  const [newAssetId, setNewAssetId] = useState<number | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ReferenceLayer | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => layers.find(l => l.id === selectedId) ?? null,
    [layers, selectedId],
  );

  const loadAssets = useCallback(() => {
    fetch('/api/reference-layers/assets', { headers: authHeaders(token) })
      .then(res => (res.ok ? res.json() : []))
      .then(data => setAssets(Array.isArray(data) ? data : []))
      .catch(() => setAssets([]));
  }, [token]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  // The preview belongs to the scene, not to this component, so it is torn down when the
  // manager closes — otherwise unsaved numbers would keep overriding the world.
  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);

  const updateDraft = (changes: Partial<ReferenceLayerDraft>) => {
    if (!selected || !draft) return;
    const next = { ...draft, ...changes };
    setDraft(next);
    onPreviewChange(previewFromDraft(selected, next));
  };

  const select = (layer: ReferenceLayer | null) => {
    setError(null);
    setConfirmDelete(null);
    setSelectedId(layer ? layer.id : null);
    setDraft(layer ? draftFromLayer(layer) : null);
    onPreviewChange(null);
  };

  const discardDraft = () => {
    if (!selected) return;
    setError(null);
    setDraft(draftFromLayer(selected));
    onPreviewChange(null);
  };

  const apply = async () => {
    if (!selected || !draft) return;
    const patch = changedFields(selected, draft);
    if (!Object.keys(patch).length) { onPreviewChange(null); return; }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-layers/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        // The draft and its preview survive: a rejected write must not cost somebody the
        // calibration they were in the middle of.
        setError(await errorFrom(res, 'Could not save those changes.'));
        return;
      }
      onPreviewChange(null);
      refreshLayers();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  /** Lock and unlock are their own requests, never bundled with an edit. */
  const setLocked = async (layer: ReferenceLayer, is_locked: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-layers/${layer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ is_locked }),
      });
      if (!res.ok) { setError(await errorFrom(res, 'Could not change the lock.')); return; }
      refreshLayers();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (layer: ReferenceLayer) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-layers/${layer.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (!res.ok) { setError(await errorFrom(res, 'Could not delete that layer.')); return; }
      setConfirmDelete(null);
      select(null);
      refreshLayers();
      loadAssets();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (chosen: File | null) => {
    const check = validateSourceFile(chosen);
    if (!check.ok) {
      setFile(null);
      setError(check.error || 'Choose a PNG or JPEG image.');
      return;
    }
    setError(null);
    setFile(chosen);
    setNewAssetId('');
    if (chosen && !newName.trim()) setNewName(chosen.name.replace(/\.[^.]+$/, ''));
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) { setError('Give the layer a name.'); return; }
    if (!file && newAssetId === '') { setError('Choose a source image, or an existing one.'); return; }

    const scale = Number(newScale);
    if (!Number.isFinite(scale) || scale <= 0) { setError('World units per pixel must be greater than zero.'); return; }

    setBusy(true);
    setError(null);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.append('image', file);
        form.append('name', name);
        form.append('world_units_per_pixel', String(scale));
        res = await fetch('/api/reference-layers/upload', { method: 'POST', headers: authHeaders(token), body: form });
      } else {
        res = await fetch('/api/reference-layers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
          body: JSON.stringify({ name, asset_id: Number(newAssetId), world_units_per_pixel: scale, rotation_rad: toRadians(0) }),
        });
      }
      if (!res.ok) { setError(await errorFrom(res, 'Could not add that layer.')); return; }

      setCreating(false);
      setFile(null);
      setNewName('');
      setNewScale('1');
      setNewAssetId('');
      if (fileInput.current) fileInput.current.value = '';
      refreshLayers();
      loadAssets();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const derived = selected && draft
    ? planeDimensions({
        source_width_px: selected.source_width_px,
        source_height_px: selected.source_height_px,
        world_center_x: 0,
        world_center_z: 0,
        world_units_per_pixel: previewFromDraft(selected, draft).world_units_per_pixel!,
        rotation_rad: 0,
      })
    : null;

  const locked = !!selected?.is_locked;

  return (
    <div className="panel reference-layer-manager" style={{ width: '320px', maxHeight: '90vh', overflowY: 'auto', pointerEvents: 'auto' }}>
      <button className="close-btn" onClick={onClose} aria-label="Close">X</button>
      <h3 style={{ margin: '0 0 10px 0', textShadow: 'var(--glow)' }}>REFERENCE_LAYERS</h3>

      {error && (
        <p role="alert" style={{ fontSize: '0.65rem', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '6px' }}>
          {error}
        </p>
      )}

      <div className="location-list" style={{ marginBottom: '10px' }}>
        {layers.length === 0 && <p style={{ fontSize: '0.65rem', opacity: 0.6 }}>No reference layers yet.</p>}
        {layers.map(layer => (
          <button
            key={layer.id}
            className={`utility-btn ${layer.id === selectedId ? 'active' : ''}`}
            style={{ width: '100%', marginBottom: '4px', textAlign: 'left' }}
            onClick={() => select(layer.id === selectedId ? null : layer)}
          >
            {layer.name}
            {layer.is_locked && <span style={{ opacity: 0.7 }}> [LOCKED]</span>}
            {!layer.is_visible && <span style={{ opacity: 0.7 }}> [HIDDEN]</span>}
          </button>
        ))}
      </div>

      {/* ── the selected layer ── */}
      {selected && draft && (
        <div style={{ borderTop: '1px solid var(--green)', paddingTop: '8px' }}>
          <p style={{ fontSize: '0.6rem', opacity: 0.7, margin: 0 }}>
            SOURCE: {selected.original_name || selected.asset_url} — {selected.source_width_px} x {selected.source_height_px} {selected.format.toUpperCase()}
          </p>
          <p style={{ fontSize: '0.55rem', opacity: 0.55, margin: '2px 0 0 0' }}>
            The source of a layer cannot be changed. Add another layer to use a different image.
          </p>

          <label style={labelStyle} htmlFor="ref-name">NAME</label>
          <input id="ref-name" style={fieldStyle} value={draft.name} disabled={locked}
            onChange={e => updateDraft({ name: e.target.value })} />

          <label style={labelStyle} htmlFor="ref-cx">WORLD_CENTER_X</label>
          <input id="ref-cx" style={fieldStyle} value={draft.world_center_x} disabled={locked}
            onChange={e => updateDraft({ world_center_x: e.target.value })} />

          <label style={labelStyle} htmlFor="ref-cz">WORLD_CENTER_Z</label>
          <input id="ref-cz" style={fieldStyle} value={draft.world_center_z} disabled={locked}
            onChange={e => updateDraft({ world_center_z: e.target.value })} />

          <label style={labelStyle} htmlFor="ref-scale">WORLD_UNITS_PER_PIXEL</label>
          <input id="ref-scale" style={fieldStyle} value={draft.world_units_per_pixel} disabled={locked}
            onChange={e => updateDraft({ world_units_per_pixel: e.target.value })} />

          <label style={labelStyle} htmlFor="ref-rot">ROTATION_DEG (CLOCKWISE)</label>
          <input id="ref-rot" style={fieldStyle} value={draft.rotation_deg} disabled={locked}
            onChange={e => updateDraft({ rotation_deg: e.target.value })} />

          {derived && (
            <p style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '6px' }}>
              WORLD_SIZE: {derived.width.toFixed(1)} x {derived.height.toFixed(1)}
            </p>
          )}

          {/* Display controls. Usable whether or not the layer is locked: hiding a drawing
              or fading it back is not editing the city. */}
          <label style={labelStyle} htmlFor="ref-opacity">OPACITY: {draft.opacity.toFixed(2)}</label>
          <input id="ref-opacity" type="range" min="0" max="1" step="0.01" style={{ width: '100%' }}
            value={draft.opacity} onChange={e => updateDraft({ opacity: Number(e.target.value) })} />

          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" checked={draft.is_visible}
              onChange={e => updateDraft({ is_visible: e.target.checked })} />
            VISIBLE
          </label>

          <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
            <button className="upload-btn" style={{ flex: 1 }} disabled={busy} onClick={apply}>APPLY</button>
            <button className="utility-btn" style={{ flex: 1 }} disabled={busy} onClick={discardDraft}>CANCEL</button>
          </div>

          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button className="utility-btn" style={{ flex: 1 }} disabled={busy}
              onClick={() => setLocked(selected, !locked)}>
              {locked ? 'UNLOCK' : 'LOCK'}
            </button>
            <button className="utility-btn danger-btn" style={{ flex: 1 }} disabled={busy || locked}
              onClick={() => setConfirmDelete(selected)}>DELETE</button>
          </div>

          {confirmDelete && confirmDelete.id === selected.id && (
            <div style={{ border: '1px solid var(--danger)', padding: '8px', marginTop: '8px' }}>
              <p style={{ fontSize: '0.65rem', margin: '0 0 6px 0' }}>Delete "{selected.name}"? This cannot be undone.</p>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="upload-btn danger-btn" style={{ flex: 1 }} disabled={busy}
                  onClick={() => remove(selected)}>CONFIRM_DELETE</button>
                <button className="utility-btn" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>KEEP</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── adding a layer ── */}
      <div style={{ borderTop: '1px solid var(--green)', paddingTop: '8px', marginTop: '10px' }}>
        {!creating ? (
          <button className="upload-btn" style={{ width: '100%' }} onClick={() => { setCreating(true); setError(null); }}>
            + ADD_REFERENCE_LAYER
          </button>
        ) : (
          <>
            <label style={labelStyle} htmlFor="ref-new-name">NAME</label>
            <input id="ref-new-name" style={fieldStyle} value={newName} onChange={e => setNewName(e.target.value)} />

            <label style={labelStyle} htmlFor="ref-file">SOURCE_IMAGE (PNG / JPEG)</label>
            <input id="ref-file" ref={fileInput} type="file" accept={ACCEPTED_SOURCE_TYPES} style={fieldStyle}
              onChange={e => chooseFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} />

            {assets.length > 0 && (
              <>
                <label style={labelStyle} htmlFor="ref-existing">OR_USE_EXISTING</label>
                <select id="ref-existing" style={fieldStyle} value={newAssetId}
                  onChange={e => {
                    const value = e.target.value === '' ? '' : Number(e.target.value);
                    setNewAssetId(value);
                    if (value !== '') { setFile(null); if (fileInput.current) fileInput.current.value = ''; }
                  }}>
                  <option value="">—</option>
                  {assets.map(asset => (
                    <option key={asset.id} value={asset.id}>
                      {asset.original_name || asset.asset_url} ({asset.source_width_px} x {asset.source_height_px})
                    </option>
                  ))}
                </select>
              </>
            )}

            <label style={labelStyle} htmlFor="ref-new-scale">WORLD_UNITS_PER_PIXEL</label>
            <input id="ref-new-scale" style={fieldStyle} value={newScale} onChange={e => setNewScale(e.target.value)} />

            <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
              <button className="upload-btn" style={{ flex: 1 }} disabled={busy} onClick={create}>ADD</button>
              <button className="utility-btn" style={{ flex: 1 }} disabled={busy}
                onClick={() => { setCreating(false); setFile(null); setError(null); }}>CANCEL</button>
            </div>
          </>
        )}
      </div>

      {/* Two separate persistent things, in two separate places. Saying so here is cheaper
          than somebody discovering it by restoring a saved map and finding no images. */}
      <p style={{ fontSize: '0.55rem', opacity: 0.5, marginTop: '10px' }}>
        Reference images are stored on the server alongside the database. Saved maps are not
        a backup of them.
      </p>
    </div>
  );
}
