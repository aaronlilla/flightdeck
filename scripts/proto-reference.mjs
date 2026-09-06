#!/usr/bin/env node
/**
 * Serves the original Claude Design prototype (with its own `support.js`
 * canvas runtime) and screenshots it at the same sizes/themes as the ported
 * board, so the two can be compared side by side. The prototype source and
 * its runtime are copied under `~/.forge/console/reference/` first -- never
 * committed to this repo -- from paths this script takes on the command
 * line, since nothing in this repository may name another machine's paths.
 *
 * Usage:
 *   node scripts/proto-reference.mjs <path-to-prototype.dc.html> <path-to-support.js>
 *
 * Requires network access to unpkg.com: `support.js` loads React/ReactDOM
 * from there at runtime -- that is the canvas runtime's own design, not
 * something this script can avoid.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const [, , protoArg, supportArg] = process.argv;
if (!protoArg || !supportArg) {
  console.error('usage: node scripts/proto-reference.mjs <prototype.dc.html> <support.js>');
  process.exit(1);
}

const refDir = join(homedir(), '.forge', 'console', 'reference');
mkdirSync(refDir, { recursive: true });
const protoDest = join(refDir, 'index.html');
const supportDest = join(refDir, 'support.js');
copyFileSync(protoArg, protoDest);
copyFileSync(supportArg, supportDest);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer((request, response) => {
  const urlPath = (request.url ?? '/').split('?')[0];
  const file = urlPath === '/' ? protoDest : join(refDir, urlPath.replace(/^\//, ''));
  if (!existsSync(file)) { response.writeHead(404); response.end('not found'); return; }
  response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});

const PORT = Number(process.env.PROTO_REFERENCE_PORT ?? 4140);
const OUT_DIR = join(process.cwd(), 'tests', 'e2e', '__screenshots__');
mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '720x900', width: 720, height: 900 },
];

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const browser = await chromium.launch();
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1500); // the canvas runtime mounts asynchronously after CDN loads
  await page.screenshot({ path: join(OUT_DIR, `proto-${size.name}-dark.png`) });
  const themeToggle = page.locator('.chipB').last();
  if (await themeToggle.count()) await themeToggle.click();
  await page.screenshot({ path: join(OUT_DIR, `proto-${size.name}-light.png`) });
  await page.close();
}
await browser.close();
server.close();

console.log(`reference screenshots written to ${OUT_DIR}`);
