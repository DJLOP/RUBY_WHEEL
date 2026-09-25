import { useEffect, useState, type ReactNode } from 'react';
import type { CanonicalApiError, CanonicalEntity, CanonicalResult } from './api';
import { canonicalApi } from './api';
import type { LifecycleState, ReplacementState } from './types';
import { describeIssue, type Availability, type FeatureActions } from './featureEditing';
import { featureActions } from './featureEditing';
import { STATE_LABEL, confirmFrame, kv, listStyle, section, smallBtn } from './panelStyles';

/**
 * Shared pieces of the WP6 register panels (anchors, scopes, connections): styles, the
 * accept confirmation, and the per-record lifecycle controls.
 *
 * Every control is one request to the lifecycle API. Accept always goes through a
 * confirmation that sends the draft_version on screen and keeps every server violation in
 * view on refusal; there is no accept-all and no combined state change.
 */

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return <><span style={{ opacity: 0.75 }}>{k}</span><span>{children}</span></>;
}

export function ActionButton({ label, availability, onClick, busy, danger }:
  { label: string; availability: Availability; onClick: () => void; busy: boolean; danger?: boolean }) {
  return (
    <button className="utility-btn" style={{ ...smallBtn, ...(danger ? { borderColor: '#ff5544', color: '#ff7766' } : {}) }}
      disabled={busy || !availability.enabled} title={availability.reason ?? ''} onClick={onClick}>
      {label}
    </button>
  );
}

export function IssueList({ label, items, color = '#ffcc55' }: { label: string; items: unknown[]; color?: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label={label} style={{ fontSize: '0.62rem', color, margin: '2px 0 0 14px', padding: 0 }}>
      {items.map((v, i) => <li key={i}>{describeIssue(v)}</li>)}
    </ul>
  );
}

/** What the manager lends a panel: its token and its one-request-at-a-time runner. */
export interface PanelOps {
  token: string;
  busy: boolean;
  /**
   * Run one request. On refusal the error is shown (and `onError` called) and nothing on
   * screen is discarded; on success `onOk` runs and canonical data is refetched.
   */
  run: <T>(request: () => Promise<CanonicalResult<T>>, onOk: (data: T) => void | Promise<void>,
    onError?: (error: CanonicalApiError) => void) => Promise<boolean>;
  notify: (message: string) => void;
}

interface GovernedLike {
  id: number;
  lifecycle_state: LifecycleState;
  draft_version: number;
  revises_id: number | null;
  replacement_state: ReplacementState;
  is_locked: boolean;
}

/**
 * The accept confirmation for any entity. It shows the caller's summary, sends exactly the
 * displayed draft_version, and on refusal stays open listing every violation.
 */
export function AcceptDialog<T extends GovernedLike>({ entity, record, label, summary, ops, onAccepted, onCancel }: {
  entity: CanonicalEntity; record: T; label: string; summary: ReactNode; ops: PanelOps;
  onAccepted: (canon: T, warnings: unknown[]) => void; onCancel: () => void;
}) {
  const [violations, setViolations] = useState<unknown[]>([]);
  const [warnings, setWarnings] = useState<unknown[]>([]);
  const accept = () => void ops.run(
    () => canonicalApi.accept<T>(ops.token, entity, record.id, record.draft_version),
    (res) => onAccepted(res.record, res.warnings ?? []),
    (err) => { setViolations(err.violations ?? []); setWarnings(err.warnings ?? []); });
  return (
    <div role="alertdialog" aria-label={`Confirm accept ${label}`} style={confirmFrame}>
      <strong>ACCEPT AS CANON?</strong>
      <div style={kv}>
        <Row k="RECORD">{record.lifecycle_state} #{record.id}, draft v{record.draft_version}</Row>
        <Row k="EFFECT">{record.revises_id ? `replaces ${label} #${record.revises_id} (same id, next revision)` : `new canonical ${label}, revision 1`}</Row>
        {summary}
        <Row k="CROSS-RECORD CHECK">{violations.length ? `${violations.length} violation(s) — see below` : 'run by the server on accept; any violation is listed here'}</Row>
      </div>
      <IssueList label="Accept violations" items={violations} color="#ff7766" />
      <IssueList label="Accept warnings" items={warnings} />
      <div>
        <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={accept}>ACCEPT DRAFT v{record.draft_version}</button>
        <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  );
}

type Pending = 'accept' | 'retire' | 'delete' | 'replacement' | null;

/**
 * Lifecycle controls for one anchor, scope or connection: accept (confirmed), delete a
 * draft (confirmed), revise, lock/unlock, replacement (confirmed), retire (confirmed).
 * Availability comes from the caller (so a must-exist anchor's replacement control is
 * simply unavailable); the server enforces every rule regardless.
 */
export function LifecycleControls<T extends GovernedLike>({
  entity, label, record, actions, ops, acceptSummary, onAccepted, onRevised, onDeleted, onEdit,
}: {
  entity: CanonicalEntity; label: string; record: T; actions: FeatureActions; ops: PanelOps; acceptSummary: ReactNode;
  onAccepted?: (canon: T) => void; onRevised?: (draft: T) => void; onDeleted?: () => void; onEdit?: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const open = record.lifecycle_state === 'draft' || record.lifecycle_state === 'proposed';
  const accepted = record.lifecycle_state === 'accepted';
  const nextReplacement: ReplacementState = record.replacement_state === 'replaceable' ? 'non_replaceable' : 'replaceable';
  const done = (msg: string) => { setPending(null); ops.notify(msg); };

  const confirmText = pending === 'retire'
    ? `Retire ${label} #${record.id}? It leaves accepted canon (restorable) and is refused while accepted records depend on it.`
    : pending === 'delete'
      ? `Delete ${record.lifecycle_state} #${record.id}? Drafts and proposals are not canon and are removed permanently.`
      : pending === 'replacement'
        ? `Change ${label} #${record.id} from ${record.replacement_state} to ${nextReplacement}? This only records permission for a future explicit replace flow; nothing replaces it automatically now.`
        : '';

  const confirmAction = () => {
    if (pending === 'retire') void ops.run(() => canonicalApi.retire<T>(ops.token, entity, record.id), () => done(`${label} #${record.id} retired.`));
    else if (pending === 'delete') void ops.run(() => canonicalApi.remove(ops.token, entity, record.id), () => { done(`${record.lifecycle_state} #${record.id} deleted.`); onDeleted?.(); });
    else if (pending === 'replacement') void ops.run(() => canonicalApi.setReplacement<T>(ops.token, entity, record.id, nextReplacement), () => done(`${label} #${record.id} is now ${nextReplacement}.`));
  };

  return (
    <div>
      <div style={{ marginTop: '4px' }}>
        {open && <>
          {onEdit && <ActionButton label="EDIT DRAFT" availability={actions.editProperties} busy={ops.busy} onClick={onEdit} />}
          <ActionButton label="ACCEPT…" availability={actions.accept} busy={ops.busy} onClick={() => setPending('accept')} />
          <ActionButton label="DELETE…" availability={actions.deleteDraft} busy={ops.busy} onClick={() => setPending('delete')} danger />
        </>}
        {accepted && <>
          <ActionButton label="REVISE" availability={actions.revise} busy={ops.busy}
            onClick={() => void ops.run(() => canonicalApi.revise<T>(ops.token, entity, record.id), (d) => {
              ops.notify(`Draft revision #${d.id} of ${label} #${record.id} created. Edit it, then accept it.`);
              onRevised?.(d);
            })} />
          {record.is_locked
            ? <ActionButton label="UNLOCK" availability={actions.unlock} busy={ops.busy}
              onClick={() => void ops.run(() => canonicalApi.setLock<T>(ops.token, entity, record.id, false), () => ops.notify(`${label} #${record.id} unlocked.`))} />
            : <ActionButton label="LOCK" availability={actions.lock} busy={ops.busy}
              onClick={() => void ops.run(() => canonicalApi.setLock<T>(ops.token, entity, record.id, true), () => ops.notify(`${label} #${record.id} locked.`))} />}
          <ActionButton label={record.replacement_state === 'replaceable' ? 'MAKE NON-REPLACEABLE…' : 'MAKE REPLACEABLE…'}
            availability={actions.replacement} busy={ops.busy} onClick={() => setPending('replacement')} />
          <ActionButton label="RETIRE…" availability={actions.retire} busy={ops.busy} onClick={() => setPending('retire')} danger />
        </>}
      </div>
      {pending === 'accept' && (
        <AcceptDialog entity={entity} record={record} label={label} summary={acceptSummary} ops={ops}
          onCancel={() => setPending(null)}
          onAccepted={(canon, warnings) => {
            setPending(null);
            ops.notify(`Accepted ${label} #${canon.id}.` + (warnings.length ? ` Warnings: ${warnings.map(describeIssue).join('; ')}` : ''));
            onAccepted?.(canon);
          }} />
      )}
      {pending && pending !== 'accept' && (
        <div role="alertdialog" aria-label={`Confirm ${pending}`} style={confirmFrame}>
          {confirmText}
          <div><button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={confirmAction}>CONFIRM</button>
            <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => setPending(null)}>CANCEL</button></div>
        </div>
      )}
    </div>
  );
}

/**
 * The retired archive of one entity type (anchors, scopes, connections), as features have:
 * retired canon never appears in the working lists, but stays recoverable here.
 *
 * Retired rows are an explicit editor-only read (`?states=retired`), made when the panel
 * opens (for the count) and again after any canonical refresh; they never join the working
 * set or the scene. Selecting one shows what it was; RESTORE is the server's own restore
 * route, which re-runs accept validation — a refusal is shown and the row stays archived.
 * There is no delete: accepted and retired canon is never hard-deleted.
 */
export function ArchiveSection<T extends { id: number; lifecycle_state: LifecycleState; is_locked: boolean; revision: number }>({
  entity, label, ops, refreshKey, describe, details,
}: {
  entity: CanonicalEntity; label: string; ops: PanelOps;
  /** Changes whenever canonical data is refetched (the working set object). */
  refreshKey: unknown;
  /** One-line identity of a retired record. */
  describe: (rec: T) => string;
  /** Inspector rows for a selected retired record. */
  details: (rec: T) => ReactNode;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [restoreError, setRestoreError] = useState<CanonicalApiError | null>(null);

  useEffect(() => {
    let live = true;
    void canonicalApi.list<T>(ops.token, entity, ['retired']).then((res) => {
      if (live && res.ok && Array.isArray(res.data)) setRows(res.data.filter(r => r.lifecycle_state === 'retired'));
    });
    return () => { live = false; };
  }, [ops.token, entity, refreshKey, reload]);

  const selected = rows.find(r => r.id === selectedId) ?? null;
  const restore = (rec: T) => {
    setRestoreError(null);
    void ops.run(() => canonicalApi.restore<T>(ops.token, entity, rec.id), (res) => {
      ops.notify(`${label} #${rec.id} restored to accepted (revision ${res.record.revision}).`
        + (res.warnings?.length ? ` Warnings: ${res.warnings.map(describeIssue).join('; ')}` : ''));
      setSelectedId(null);
      setReload(n => n + 1);
    }, setRestoreError);
  };

  return (
    <div style={section} aria-label={`${label} archive`}>
      <button className="utility-btn" style={smallBtn} aria-expanded={open} onClick={() => { setOpen(v => !v); setReload(n => n + 1); }}>
        {open ? 'HIDE' : 'SHOW'} RETIRED / ARCHIVE ({rows.length})
      </button>
      {open && (
        <>
          <ul aria-label={`Retired ${label}s`} style={{ ...listStyle, maxHeight: '140px' }}>
            {rows.length === 0 && <li style={{ opacity: 0.6 }}>No retired {label}s.</li>}
            {rows.map(r => (
              <li key={r.id}>
                <button className="utility-btn" data-archived-id={r.id} aria-pressed={r.id === selectedId}
                  style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', opacity: 0.85,
                    ...(r.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                  onClick={() => { setSelectedId(r.id); setRestoreError(null); }}>
                  {describe(r)} · RETIRED · r{r.revision}
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div aria-label={`Retired ${label}`} style={{ border: '1px solid var(--dark-green)', padding: '4px', marginTop: '4px' }}>
              <div style={kv}>
                <Row k="STATE">{STATE_LABEL[selected.lifecycle_state]} · r{selected.revision}</Row>
                {details(selected)}
              </div>
              <ActionButton label="RESTORE" availability={featureActions(selected).restore} busy={ops.busy} onClick={() => restore(selected)} />
              <IssueList label="Restore refusal" color="#ff7766"
                items={restoreError ? [restoreError.error, ...(restoreError.violations ?? [])] : []} />
            </div>
          )}
          <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>
            Retired canon is kept for recovery and history, never deleted. Restore re-runs the server&apos;s accept validation.
          </div>
        </>
      )}
    </div>
  );
}
