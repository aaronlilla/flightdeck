import type { JSX } from 'react';

import type { ToastSpec } from '../store.js';

export interface ToastProps {
  toast: ToastSpec | null;
}

/** Merge-moment toast: id · duration · cost · tally, bottom right. */
export function Toast({ toast }: ToastProps): JSX.Element | null {
  if (!toast) return null;
  return (
    <div
      className="plate" data-testid="toast"
      style={{ position: 'fixed', right: 20, bottom: 24, zIndex: 40, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderColor: toast.color ?? 'var(--run)', width: 420 }}
    >
      <span className="m" style={{ fontSize: 'var(--fs-heading)', color: toast.color ?? 'var(--run)' }}>{toast.glyph}</span>
      <div style={{ flex: 1 }}>
        <div className="m" style={{ fontSize: 'var(--fs-body)', fontWeight: 700 }}>{toast.title}</div>
        <div className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>{toast.sub}</div>
      </div>
      <span className="m" style={{ fontSize: 'var(--fs-heading)', fontWeight: 700, color: toast.color ?? 'var(--run)' }}>{toast.big}</span>
    </div>
  );
}
