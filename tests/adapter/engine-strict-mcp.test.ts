/**
 * Workers must not inherit the user's or the repo's MCP servers: each one is a separate
 * process per session (cloudwatch alone is ~1.4 GB), and inheriting them was what ran the
 * machine out of memory with several runs live. buildOptions passes strictMcpConfig
 * through only when asked, so interactive sessions keep their servers.
 */
import { describe, expect, it } from 'vitest';

import { buildOptions } from '../../src/adapter/engine.js';

const base = { cwd: '.', canUseTool: (async () => ({ behavior: 'allow' })) as never };

describe('strictMcpConfig', () => {
  it('reaches the SDK when the engine config asks for it', () => {
    expect(buildOptions({ ...base, strictMcpConfig: true } as never).strictMcpConfig).toBe(true);
  });

  it('is absent when not asked for', () => {
    expect(buildOptions({ ...base } as never).strictMcpConfig).toBeUndefined();
  });
});
