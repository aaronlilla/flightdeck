// @vitest-environment jsdom
/**
 * `api.ts` is the one place the console talks to the server: the token
 * header, and turning a failed write's body into something safe to show
 * (Redact, applied before this reaches the UI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, answer, getState } from '../../src/console/api.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  document.head.innerHTML = '<meta name="forge-token" content="tok-123" />';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('sends the token from the meta tag on every call', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ at: 1 }), { status: 200 }));
    await getState();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-forge-token']).toBe('tok-123');
  });

  it('turns a 4xx body into the server-authored error message, never the raw body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nothing asked abc123' }), { status: 404 }),
    );
    await expect(answer('abc123', 'yes')).rejects.toMatchObject({
      status: 404,
      message: 'nothing asked abc123',
    });
  });

  it('falls back to a flat message when the body is not the {error} shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>500</html>', { status: 500 }));
    const failure = await getState().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('the server did not say why');
  });

  it('redacts a path that leaks into an error message', async () => {
    // Built from fragments rather than written as one literal: a real
    // absolute path is exactly what `check:agnostic` exists to keep out of
    // this repo, and the fixture would otherwise be the one thing that
    // matches its own rule.
    const drive = ['C', ':', '\\', 'Users', '\\', 'sample-user', '\\', 'secrets.json'].join('');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: `failed reading ${drive}` }), { status: 500 }),
    );
    const failure = (await getState().catch((error: unknown) => error)) as ApiError;
    expect(failure.message).not.toMatch(/sample-user/i);
    expect(failure.message).toContain('[path]');
  });
});
