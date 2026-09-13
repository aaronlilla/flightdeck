/**
 * A read-only preview of THIS checkout's console against the LIVE server's data.
 *
 *     npm run console:build
 *     npx tsx tests/live/preview.ts            # serves on 4121, reads 4120
 *     npx tsx tests/live/drive.ts --base http://127.0.0.1:4121
 *
 * Why it exists. The console of record serves a different checkout, other sessions are
 * working against it, and restarting it is not this session's call. Without this, a
 * console fix could only be looked at through the stub -- and the stub is a sensor built
 * from the same assumptions as the components it would be measuring (standing order 6).
 *
 * What it does: serves the bundle this checkout just built, and forwards every API read
 * to the live server untouched. So the screen is this branch's code and the data is
 * today's real fleet.
 *
 * What it cannot do: write. Every method but GET and HEAD is refused with a 405 before
 * it reaches the network, so no click on a preview page can answer a real question,
 * confirm a real kill, or merge anything. That is a mechanism, not a rule -- the brief's
 * "never click a real card" is enforced here rather than remembered.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { settleDeadConfirms } from '../../src/forge/console/thread.js';
import { classifyRef, fromBoard, fromJira, mergeTicket, notFound, prNumberFrom, pullRequestFromBoard, runFromBoard } from '../../src/forge/console/whatis.js';
import { createJiraWriteClient } from '../../src/forge/intake/jira.js';
import { jiraConfigFromEnv } from '../../src/forge/queue-wire.js';
import type { Message } from '../../src/shared/console-model.js';

const LIVE = process.env['FORGE_LIVE_BASE'] ?? 'http://127.0.0.1:4120';
const PORT = Number(process.env['FORGE_PREVIEW_PORT'] ?? 4121);
const DIST = join(process.cwd(), 'dist/console');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** The live server's own token, lifted off the page it serves, so forwarded reads carry
 *  the header the real routes require. */
async function liveToken(): Promise<string> {
  const html = await (await fetch(LIVE + '/')).text();
  return /name="forge-token" content="([^"]*)"/.exec(html)?.[1] ?? '';
}

function serveFile(path: string, response: ServerResponse): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
  return true;
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`No built console at ${DIST}. Run \`npm run console:build\` first.`);
  }
  const token = await liveToken();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // The one rule this server exists to make impossible to break.
        response.writeHead(405, { 'content-type': 'text/plain' });
        response.end('This preview is read-only. It never writes to the live pipeline.');
        return;
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
      const asset = normalize(join(DIST, url.pathname)).startsWith(DIST) ? join(DIST, url.pathname) : DIST;

      if (url.pathname === '/') {
        // The page needs a token in its meta tag or every read it makes is refused.
        const html = (await (await fetch(LIVE + '/')).text())
          .replace(/src="\/assets\/[^"]*"/, `src="${await assetHref('js')}"`)
          .replace(/href="\/assets\/[^"]*\.css"/, `href="${await assetHref('css')}"`);
        response.writeHead(200, { 'content-type': TYPES['.html']! });
        response.end(html);
        return;
      }
      if (serveFile(asset, response)) return;

      if (url.pathname === '/whatis') {
        // Answered from THIS checkout, because the live server is on an older head and
        // returns 404 for a route it does not have yet. The board half is real data
        // proxied from it; the Jira half is absent here, since the preview holds no
        // credentials -- which is the same answer an unconfigured console gives.
        const ref = url.searchParams.get('ref') ?? '';
        // In parallel: the real route reads both in-process, so two sequential round
        // trips here would make the preview look slower than the thing it previews.
        const [lanesBody, queueBody] = await Promise.all([
          fetch(LIVE + '/lanes?all=1', { headers: { 'x-forge-token': token } }).then((r) => r.json() as Promise<{ lanes?: any[] }>),
          fetch(LIVE + '/queue', { headers: { 'x-forge-token': token } }).then((r) => r.json() as Promise<{ items?: any[] }>),
        ]);
        const lanes = lanesBody.lanes ?? [];
        const queue = queueBody.items ?? [];
        const kind = classifyRef(ref);
        // The Jira half too, when this shell carries the credentials, so the preview
        // shows the card a person will actually see rather than the board-only half.
        if (kind === 'ticket') {
          const config = jiraConfigFromEnv();
          const issue = config ? await createJiraWriteClient(config).read(ref).catch(() => null) : null;
          if (issue) {
            const merged = mergeTicket(fromJira(ref, issue, config?.site ?? null), fromBoard(ref, lanes, queue));
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(merged));
            return;
          }
        }
        const answer = kind === 'pull-request'
          ? (pullRequestFromBoard(prNumberFrom(ref) ?? -1, lanes, queue) ?? notFound(ref))
          : kind === 'ticket'
            ? (fromBoard(ref, lanes, queue) ?? notFound(ref))
            : (runFromBoard(ref, lanes) ?? fromBoard(ref, lanes, queue) ?? notFound(ref));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(answer));
        return;
      }
      const upstream = await fetch(LIVE + url.pathname + url.search, { headers: { 'x-forge-token': token } });
      let body = await upstream.text();
      if (url.pathname === '/thread' && upstream.ok) {
        // The live server runs the console-of-record's checkout, not this one, so a
        // server-side change has to be applied here for the preview to show it. This is
        // the same function the route itself calls, over the same payload -- not a
        // reimplementation of it. Without the live process's pending map to ask, it
        // falls back to the token's own lifetime, which is what the route does for an
        // unwired caller too.
        const thread = JSON.parse(body) as { messages: Message[]; cards?: Message[] };
        body = JSON.stringify({ ...thread, cards: settleDeadConfirms(thread.cards ?? [], Date.now()) });
      }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      response.end(body);
    })().catch((error: unknown) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });

  /** This build's own hashed asset names, so the live server's index can point at them. */
  async function assetHref(kind: 'js' | 'css'): Promise<string> {
    const { readdirSync } = await import('node:fs');
    const name = readdirSync(join(DIST, 'assets')).find((file) => file.endsWith('.' + kind));
    return `/assets/${name ?? ''}`;
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`preview  http://127.0.0.1:${PORT}   (this checkout's console, live data from ${LIVE}, reads only)`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
