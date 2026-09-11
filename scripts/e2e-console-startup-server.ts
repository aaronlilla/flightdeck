/**
 * G5 live end-to-end specimen: a real `ForgeServer` on an ephemeral port, with
 * an overridable `consoleDistDir` so the harness can flip it from "not built"
 * to "built" mid-run (Verification case 2). Never the real 4120.
 *
 * Prints `PORT=<n>` on its own line once listening, so the driver script (a
 * separate process, since this one needs `tsx` to run TS source) can read it
 * back without a race on a fixed port.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/forge/inbox.js';
import { Journal } from '../src/forge/journal.js';
import { Registry } from '../src/forge/registry.js';
import { Lanes } from '../src/forge/supervisor.js';
import { ForgeServer } from '../src/forge/server.js';

const consoleDistDir = process.argv[2];
if (!consoleDistDir) {
  console.error('usage: tsx e2e-console-startup-server.ts <consoleDistDir>');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-server-'));
process.env['FORGE_HOME'] = dir;
const lanes = new Lanes(join(dir, 'lanes'));
const journal = new Journal(join(dir, 'fleet.jsonl'));
journal.close();
const registry = new Registry(join(dir, 'registry'));

const server = new ForgeServer({
  lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'), registry, port: 0,
  consoleDistDir,
});

server.listen().then((port) => {
  console.log(`PORT=${port}`);
});

process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void server.close().then(() => process.exit(0)); });
