import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { probeHealth } from '../probe';

let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

/** Every fake server here binds an ephemeral port (never 4120 -- that is the
 *  live console other sessions depend on) and each test reads its own port
 *  back off the listening socket. */
function fakeServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('probeHealth', () => {
  it('reads down when nothing is listening on the port', async () => {
    // An ephemeral port nothing is bound to: grab one, close it immediately.
    const { server, port } = await fakeServer(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await probeHealth(500, port);
    expect(result.health).toBe('down');
  });

  it('reads up-healthy on a 200 /health', async () => {
    const { server, port } = await fakeServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ consoleBuilt: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    const result = await probeHealth(500, port);
    expect(result.health).toBe('up-healthy');
  });

  it('reads up-no-console on a 503 /health', async () => {
    const { server, port } = await fakeServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ consoleBuilt: false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    const result = await probeHealth(500, port);
    expect(result.health).toBe('up-no-console');
  });

  it('reads up-foreign when something non-forge-shaped answers', async () => {
    const { server, port } = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from something else entirely');
    });
    servers.push(server);
    const result = await probeHealth(500, port);
    expect(result.health).toBe('up-foreign');
  });

  it('a server that answers after 3s reads up-healthy, where a 1.5s-timeout probe would read down', async () => {
    const { server, port } = await fakeServer((req, res) => {
      res.on('error', () => {});
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ consoleBuilt: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, 3000);
    });
    servers.push(server);

    // The old probe's 1.5s timeout would have read this exact server as down;
    // proven directly rather than re-running the legacy function, since it is
    // pinned to the real port 4120 and reusing it here would mean probing the
    // live console instead of this fake one.
    const tooShort = await probeHealth(1500, port);
    expect(tooShort.health).toBe('down');

    const result = await probeHealth(10_000, port);
    expect(result.health).toBe('up-healthy');
  }, 15000);

  // G5, 2026-09-10: FORGE_CONSOLE_ORIGIN must redirect the whole app, not just
  // the window -- otherwise a live end-to-end test against a specimen server
  // would still have the supervisor's own probe checking the real port 4120.
  it('defaults to the port named by FORGE_CONSOLE_ORIGIN when the port argument is omitted', async () => {
    const { server, port } = await fakeServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ consoleBuilt: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const previous = process.env['FORGE_CONSOLE_ORIGIN'];
    process.env['FORGE_CONSOLE_ORIGIN'] = `http://127.0.0.1:${port}`;
    try {
      const result = await probeHealth(500);
      expect(result.health).toBe('up-healthy');
    } finally {
      if (previous === undefined) delete process.env['FORGE_CONSOLE_ORIGIN'];
      else process.env['FORGE_CONSOLE_ORIGIN'] = previous;
    }
  });
});
