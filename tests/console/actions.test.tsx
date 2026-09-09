// @vitest-environment jsdom
/**
 * The two pieces of `actions.ts` that are not the catalog: the sentence a rejection
 * turns into, and the toast that carries it on views with no rail.
 *
 * The catalog itself is checked elsewhere. `actions-catalog.test.ts` proves every
 * mutating export of `api.ts` has an entry; `action-contract.test.tsx` drives all of
 * them through pending, the inline answer, the rail receipt, the effect link and the
 * server-issued confirm. Busy state and the guard against a second click while one is
 * in flight live there, once per entry rather than once here.
 */
import type { JSX } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';

import { errorText } from '../../src/console/actions.js';
import { ApiError } from '../../src/console/api.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';

describe('errorText', () => {
  // A 501 that names both what refused and why used to reach the operator as the
  // first half alone, which reads as a bug in the console rather than an unbuilt path.
  it('keeps both halves of a folded "error: reason" sentence', () => {
    const text = errorText(new ApiError(501, 'not wired: no repo/PR on record for run x to re-audit'));
    expect(text).toContain('not wired');
    expect(text).toContain('no repo/PR on record');
  });

  it('parses a raw {error, reason} JSON body and keeps both', () => {
    const text = errorText(new ApiError(501, JSON.stringify({ error: 'not wired', reason: 'no repo/PR on record for run x to re-audit' })));
    expect(text).toContain('not wired');
    expect(text).toContain('no repo/PR on record');
  });

  it('keeps a JSON body that carries only an error', () => {
    expect(errorText(new ApiError(422, JSON.stringify({ error: 'the cap is above the hard limit' }))))
      .toBe('the cap is above the hard limit');
  });

  it('falls back to the status when the server said nothing at all', () => {
    expect(errorText(new ApiError(500, ''))).toBe('the server answered 500');
  });

  it('carries a plain Error through, and stringifies anything else', () => {
    expect(errorText(new Error('the socket closed'))).toBe('the socket closed');
    expect(errorText('just a string')).toBe('just a string');
  });
});

describe('errorText', () => {
  // A 501 that names both what refused and why used to reach the operator as the
  // first half alone, which reads as a bug in the console rather than an unbuilt path.
  it('keeps both halves of a folded "error: reason" sentence', () => {
    const text = errorText(new ApiError(501, 'not wired: no repo/PR on record for run x to re-audit'));
    expect(text).toContain('not wired');
    expect(text).toContain('no repo/PR on record');
  });

  it('parses a raw {error, reason} JSON body and keeps both', () => {
    const text = errorText(new ApiError(501, JSON.stringify({ error: 'not wired', reason: 'no repo/PR on record for run x to re-audit' })));
    expect(text).toContain('not wired');
    expect(text).toContain('no repo/PR on record');
  });

  it('keeps a JSON body that carries only an error', () => {
    expect(errorText(new ApiError(422, JSON.stringify({ error: 'the cap is above the hard limit' }))))
      .toBe('the cap is above the hard limit');
  });

  it('falls back to the status when the server said nothing at all', () => {
    expect(errorText(new ApiError(500, ''))).toBe('the server answered 500');
  });

  it('carries a plain Error through, and stringifies anything else', () => {
    expect(errorText(new Error('the socket closed'))).toBe('the socket closed');
    expect(errorText('just a string')).toBe('just a string');
  });
});
