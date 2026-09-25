import { useState } from 'react';
import type { CanonicalGeographyData } from './api';
import type { CanonicalFeature, CanonicalPolygon, GeoScope } from './types';
import { SCOPE_KIND_LABEL, landMembership, scopeLabel } from './scopes';
import { spatialScopesOf, type ContentRow, type ScopeSpatial } from './scopeContents';
import { geometryMetrics } from './featureEditing';
import { formatArea, formatLength } from './physicalScale';
import { polygonArea } from './geometry';
import { STATE_LABEL, fieldStyle, kv, smallBtn } from './panelStyles';

/**
 * The left-side context pane (WP6 live-acceptance remediation): context for what is
 * selected in the world, beside the right-side authoring manager.
 *
 * For a scope it shows what the scope spatially contains — for accepted canon, the WP3
 * query bundle — grouped and collapsible (land inside / on-or-crossing the boundary /
 * context, anchors, routes, water, protected regions, sites, connections), and keeps the
 * optional explicit whole-island members in a separate section. For a feature it shows
 * identity and context. Rows highlight on hover/focus and open the feature on click.
 * Lifecycle and authoring stay in the right-hand manager.
 */

const PAGE = 25;

const paneStyle = {
  position: 'fixed' as const, top: '80px', left: '20px', width: '300px', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' as const,
  zIndex: 1500, padding: '10px', fontSize: '0.65rem',
};

interface RowProps {
  onHover: (id: number | null) => void;
  onInspect: (id: number) => void;
}

function FeatureRowButton({ id, label, onHover, onInspect }: { id: number; label: string } & RowProps) {
  return (
    <button className="utility-btn" data-context-feature={id}
      style={{ width: '100%', textAlign: 'left', fontSize: '0.6rem', padding: '1px 4px', marginTop: '1px' }}
      onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(id)} onBlur={() => onHover(null)}
      onClick={() => onInspect(id)}>
      {label}
    </button>
  );
}

/** A collapsible group, paged and filterable so hundreds of rows never render as one dump. */
function Group({ title, rows, open = false, ...handlers }: { title: string; rows: ContentRow[]; open?: boolean } & RowProps) {
  const [shown, setShown] = useState(PAGE);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const matching = q ? rows.filter(r => r.label.toLowerCase().includes(q)) : rows;
  return (
    <details open={open} data-group={title} style={{ marginTop: '3px' }}>
      <summary>{title} ({rows.length})</summary>
      {rows.length > PAGE && (
        <input aria-label={`Filter ${title}`} placeholder="filter" value={filter} style={{ ...fieldStyle, marginTop: '2px' }}
          onChange={e => { setFilter(e.target.value); setShown(PAGE); }} />
      )}
      {rows.length === 0 && <div style={{ opacity: 0.6 }}>none</div>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {matching.slice(0, shown).map((r, i) => (
          <li key={`${r.featureId ?? 'x'}-${i}`}>
            {r.featureId !== null
              ? <FeatureRowButton id={r.featureId} label={r.label} {...handlers} />
              : <span style={{ opacity: 0.85 }}>{r.label}</span>}
            {r.parts && r.parts.length > 1 && (
              <ul style={{ listStyle: 'none', paddingLeft: '10px', margin: 0 }}>
                {r.parts.map(p => <li key={p.featureId}><FeatureRowButton id={p.featureId} label={p.label} {...handlers} /></li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {matching.length > shown && (
        <button className="utility-btn" style={smallBtn} onClick={() => setShown(n => n + PAGE)}>SHOW {Math.min(PAGE, matching.length - shown)} MORE of {matching.length - shown}</button>
      )}
    </details>
  );
}

interface Props extends RowProps {
  data: CanonicalGeographyData;
  scope: GeoScope | null;
  feature: CanonicalFeature | null;
  focus: 'scope' | 'feature';
  spatial: ScopeSpatial;
  loading: boolean;
  error: string | null;
  onBackToScope: () => void;
  onOpenScope: (id: number) => void;
  onClose: () => void;
}

export function ContextPane({ data, scope, feature, focus, spatial, loading, error, onHover, onInspect, onBackToScope, onOpenScope, onClose }: Props) {
  const handlers = { onHover, onInspect };
  const landRows = (ids: number[]): ContentRow[] => ids.map(id => {
    const f = data.features.find(x => x.id === id);
    const poly = f?.geometry as CanonicalPolygon | undefined;
    return { featureId: id, relation: null,
      label: `#${id} ${f?.name || '(unnamed island)'}${poly?.outer ? ` · ${formatArea(polygonArea(poly.outer, poly.holes ?? []))}` : ''}` };
  });

  return (
    <aside className="panel canonical-context-pane" aria-label="Canonical context" style={paneStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.72rem' }}>CONTEXT</strong>
        <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} aria-label="Close context" onClick={onClose}>X</button>
      </div>

      {focus === 'feature' && feature ? (
        <FeatureCard feature={feature} data={data} scope={scope} onBackToScope={onBackToScope} onOpenScope={onOpenScope} />
      ) : scope ? (
        <div aria-label="Scope context">
          <div style={{ fontSize: '0.72rem', fontWeight: 'bold' }}>{SCOPE_KIND_LABEL[scope.scope_kind].toUpperCase()} · {scope.name}</div>
          <div style={kv}>
            <span>STATE</span><span>{STATE_LABEL[scope.lifecycle_state]}{scope.lifecycle_state === 'accepted' ? ` · r${scope.revision}` : ''}</span>
            <span>LAND COVERAGE</span><span>{scope.land_coverage}</span>
            <span>BOUNDARY</span><span>{scope.boundary_feature_id
              ? <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onInspect(scope.boundary_feature_id!)}
                onMouseEnter={() => onHover(scope.boundary_feature_id)} onMouseLeave={() => onHover(null)}>INSPECT RAW BOUNDARY #{scope.boundary_feature_id}</button>
              : 'none'}</span>
            <span>SOURCE</span><span data-source={spatial.source}>{spatial.source === 'query' ? 'canonical query (accepted canon)'
              : spatial.source === 'preview' ? 'preview from the draft (not yet canon)' : '—'}</span>
          </div>
          {loading && <div>Loading spatial contents…</div>}
          {error && <div role="alert" style={{ color: '#ff7766' }}>{error}</div>}

          <div aria-label="Spatial land" style={{ marginTop: '6px' }}>
            <strong>SPATIAL LAND</strong> <span style={{ opacity: 0.7 }}>(derived from the extent — not membership)</span>
            <Group title="Inside" rows={landRows(spatial.land.inside)} open {...handlers} />
            <Group title="On / crossing boundary" rows={landRows(spatial.land.crossing)} open {...handlers} />
            {spatial.land.context.length > 0 && <Group title="Context (halo)" rows={landRows(spatial.land.context)} {...handlers} />}
          </div>

          {spatial.source === 'query' && (
            <div aria-label="Other spatial contents" style={{ marginTop: '6px' }}>
              <strong>OTHER CANON IN EXTENT</strong>
              <Group title="Anchors" rows={spatial.groups.anchors} {...handlers} />
              <Group title="Routes" rows={spatial.groups.routes} {...handlers} />
              <Group title="Water" rows={spatial.groups.water} {...handlers} />
              <Group title="Protected regions" rows={spatial.groups.protected} {...handlers} />
              <Group title="Sites" rows={spatial.groups.sites} {...handlers} />
              <Group title="Connections" rows={spatial.groups.connections} {...handlers} />
            </div>
          )}

          <div aria-label="Explicit members" style={{ marginTop: '6px', borderTop: '1px solid var(--dark-green)', paddingTop: '4px' }}>
            <strong>EXPLICIT WHOLE-ISLAND MEMBERS</strong> <span style={{ opacity: 0.7 }}>({scope.members.length}{scope.scope_kind === 'island_group' ? '' : ', optional'})</span>
            <Group title="Members" rows={landRows(scope.members)} {...handlers} />
          </div>
        </div>
      ) : <div style={{ opacity: 0.6 }}>Select a scope or feature.</div>}
    </aside>
  );
}

function FeatureCard({ feature: f, data, scope, onBackToScope, onOpenScope }: {
  feature: CanonicalFeature; data: CanonicalGeographyData; scope: GeoScope | null; onBackToScope: () => void; onOpenScope: (id: number) => void;
}) {
  const m = geometryMetrics(f.geometry_type, f.geometry);
  const boundaryOf = data.scopes.filter(s => s.revises_id === null && s.boundary_feature_id === (f.revises_id ?? f.id));
  const isLand = f.feature_class === 'land' && f.geometry_type === 'polygon';
  const membership = isLand ? landMembership(data.scopes, f.id) : null;
  const spatialScopes = isLand ? spatialScopesOf(f, data.scopes, data.features) : [];
  const anchor = f.anchor_id ? data.anchors.find(a => a.id === f.anchor_id) : null;
  return (
    <div aria-label="Feature context">
      {scope && <button className="utility-btn" style={smallBtn} onClick={onBackToScope}>← BACK TO {scopeLabel(scope)}</button>}
      <div style={{ fontSize: '0.72rem', fontWeight: 'bold', marginTop: '3px' }}>#{f.id} {f.name || '(unnamed)'}</div>
      <div style={kv}>
        <span>CLASS</span><span>{f.feature_class === 'land' ? 'land (island)' : f.feature_class}{f.kind ? ` / ${f.kind}` : ''}</span>
        <span>STATE</span><span>{STATE_LABEL[f.lifecycle_state]}{f.lifecycle_state === 'accepted' ? ` · r${f.revision}` : ''}</span>
        <span>STRENGTH</span><span>{f.constraint_strength}</span>
        {m.areaWu2 !== null && <><span>AREA</span><span>{formatArea(m.areaWu2)}</span></>}
        {m.lengthWu !== null && <><span>{f.geometry_type === 'polygon' ? 'PERIMETER' : 'LENGTH'}</span><span>{formatLength(m.lengthWu)}</span></>}
        {anchor && <><span>ANCHOR PART</span><span>{anchor.name}{f.part_role ? ` · ${f.part_role}` : ''}</span></>}
      </div>
      {boundaryOf.length > 0 && (
        <div>Boundary of: {boundaryOf.map(s => (
          <button key={s.id} className="utility-btn" style={smallBtn} onClick={() => onOpenScope(s.id)}>{scopeLabel(s)}</button>))}</div>
      )}
      {isLand && (
        <div aria-label="Land context" style={{ marginTop: '4px' }}>
          <div><strong>SPATIALLY IN</strong> <span style={{ opacity: 0.7 }}>(derived from boundaries)</span>:{' '}
            {spatialScopes.length ? spatialScopes.map(({ scope: s, relation }) => (
              <button key={s.id} className="utility-btn" style={smallBtn} onClick={() => onOpenScope(s.id)}>
                {s.name} · {relation === 'inside' ? 'inside' : 'crossing'}
              </button>)) : 'no drawn scope boundary'}</div>
          <div><strong>EXPLICIT MEMBERSHIP</strong>: {membership && membership.accepted.length
            ? membership.chain.map(s => s.name ?? `#${s.id}`).join(' → ') : 'none'}</div>
        </div>
      )}
      <div style={{ opacity: 0.7, marginTop: '4px' }}>Lifecycle and editing are in the right-hand manager.</div>
    </div>
  );
}
