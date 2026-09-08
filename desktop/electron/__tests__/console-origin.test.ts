import { describe, expect, it } from 'vitest';

import { consoleOrigin, DEFAULT_CONSOLE_ORIGIN } from '../console-origin';

describe('consoleOrigin', () => {
  it('points at the forge server when nothing is set', () => {
    expect(consoleOrigin({})).toBe('http://127.0.0.1:4120');
    expect(consoleOrigin({ FORGE_CONSOLE_ORIGIN: '  ' })).toBe(DEFAULT_CONSOLE_ORIGIN);
  });

  it('takes an override and keeps only its origin', () => {
    expect(consoleOrigin({ FORGE_CONSOLE_ORIGIN: 'http://127.0.0.1:5173/' })).toBe('http://127.0.0.1:5173');
    expect(consoleOrigin({ FORGE_CONSOLE_ORIGIN: 'http://localhost:5173/board?x=1' })).toBe('http://localhost:5173');
  });

  it('refuses a value that is not an http URL', () => {
    expect(() => consoleOrigin({ FORGE_CONSOLE_ORIGIN: '5173' })).toThrow(/not a URL/);
    expect(() => consoleOrigin({ FORGE_CONSOLE_ORIGIN: 'file:///C:/x' })).toThrow(/http or https/);
  });
});
