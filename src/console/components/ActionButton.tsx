import type { CSSProperties, JSX, ReactNode } from 'react';
import { useContext } from 'react';

import { ActionsContext, useAction, type ActionSpec } from '../actions.js';
import { actionable } from '../keyboard-actionable.js';
import type { ActionOutcome } from '../store.js';

/**
 * A control bound to one catalog entry, with the four-part contract rendered next to
 * it: the button reads busy and stops taking clicks while the call is in flight, the
 * answer appears beside the button as the server's message or the verbatim error with
 * a link to where the effect can be seen, and an irreversible entry shows the server's
 * confirm card in the same spot before anything runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ActionButtonProps<A extends any[], R> {
  spec: ActionSpec<A, R>;
  /** The call's arguments, fixed at render: the lane id, the queue item, the caps. */
  args: A;
  /** Tells two controls for the same action apart. Defaults to the first argument. */
  actionRef?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** What the button says while the call is in flight. */
  busy?: string;
  /** A control that is not usable right now, for a reason the caller knows. */
  disabled?: boolean;
  /** Where the outcome renders: beside the button, or nowhere (the caller renders
   *  `ActionOutcomeView` itself, elsewhere). */
  outcome?: 'inline' | 'none';
  testId?: string;
  stopPropagation?: boolean;
  onOutcome?: (outcome: ActionOutcome) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ActionButton<A extends any[], R>(props: ActionButtonProps<A, R>): JSX.Element {
  const {
    spec, args, actionRef, className = 'btnS', style, children, busy, disabled = false, outcome = 'inline', testId,
    stopPropagation = false, onOutcome,
  } = props;
  const ref = actionRef ?? (typeof args[0] === 'string' ? args[0] : undefined);
  const handle = useAction(spec, ref);
  const blocked = handle.pending || disabled;
  const activate = actionable((e) => {
    if (stopPropagation) e?.stopPropagation?.();
    if (blocked) return;
    void handle.run(...args).then((result) => onOutcome?.(result));
  });
  return (
    <>
      <span
        {...activate}
        className={`${className}${handle.pending ? ' btnBusy' : ''}`}
        style={{
          ...style,
          ...(handle.pending ? { display: 'inline-flex', alignItems: 'center', gap: 6 } : {}),
          ...(blocked ? { opacity: 0.55, cursor: 'default' } : {}),
        }}
        aria-disabled={blocked}
        aria-busy={handle.pending}
        data-testid={testId ?? `action-${spec.id}${ref ? `-${ref}` : ''}`}
        data-pending={handle.pending ? 'true' : 'false'}
      >
        {/* The spinner the action-feedback stream put on the two lane CTAs, here
            instead so every catalog control gets it rather than those two. */}
        {handle.pending ? <span className="fdSpinner" aria-hidden="true" /> : null}
        {handle.pending ? (busy ?? `${spec.label}…`) : (children ?? spec.label)}
      </span>
      {outcome === 'inline' ? (
        <ActionOutcomeView
          result={handle.result} pending={handle.pending} specId={spec.id} actionRef={ref}
          onConfirm={() => { void handle.confirm().then((result) => { if (result) onOutcome?.(result); }); }}
          onDismiss={handle.dismiss} onClear={handle.clear} stopPropagation={stopPropagation}
        />
      ) : null}
    </>
  );
}

export interface ActionOutcomeViewProps {
  result: ActionOutcome | null;
  pending: boolean;
  specId: string;
  actionRef?: string;
  onConfirm: () => void;
  onDismiss: () => void;
  onClear: () => void;
  stopPropagation?: boolean;
}

/** The result of one action, where its control is. */
export function ActionOutcomeView(props: ActionOutcomeViewProps): JSX.Element | null {
  const { result, pending, specId, actionRef, onConfirm, onDismiss, onClear, stopPropagation = false } = props;
  const host = useContext(ActionsContext);
  const suffix = `${specId}${actionRef ? `-${actionRef}` : ''}`;
  const guard = (fn: () => void) => (e?: { stopPropagation?: () => void }) => { if (stopPropagation) e?.stopPropagation?.(); fn(); };
  if (pending || !result) return null;
  if (result.kind === 'confirm') {
    return (
      <span
        className="m actionConfirm" data-testid={`action-confirm-${suffix}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-meta)', padding: '4px 8px', border: '1px solid var(--block)', borderRadius: 4 }}
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
      >
        <span style={{ color: 'var(--ink2)' }}>Confirm, irreversible: {result.blast}</span>
        <span className="btnR" style={{ padding: '4px 8px', fontSize: 'var(--fs-meta)' }} data-testid={`action-confirm-yes-${suffix}`} {...actionable(guard(onConfirm))}>Confirm</span>
        <span className="btnS" style={{ padding: '4px 8px', fontSize: 'var(--fs-meta)' }} data-testid={`action-confirm-no-${suffix}`} {...actionable(guard(onDismiss))}>Not now</span>
      </span>
    );
  }
  return (
    <span
      className="m actionResult" data-testid={`action-result-${suffix}`} data-ok={result.ok ? 'true' : 'false'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-meta)', color: result.ok ? 'var(--run)' : 'var(--block)' }}
      onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
    >
      <span aria-hidden="true">{result.ok ? '✓' : '✕'}</span>
      <span style={{ color: 'var(--ink)' }}>{result.text}</span>
      {result.link ? (
        <a data-testid={`action-link-${suffix}`} style={{ color: 'var(--ink2)', cursor: 'pointer' }} {...actionable(guard(() => host.follow(result.link!)))}>
          {result.link.label} ▸
        </a>
      ) : null}
      <a aria-label="dismiss result" style={{ color: 'var(--ink3)', cursor: 'pointer' }} {...actionable(guard(onClear))}>×</a>
    </span>
  );
}
