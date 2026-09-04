#!/usr/bin/env node
// tsc only emits compiled .ts sources, so a JSON file the runtime reads with a plain
// readFileSync (model-policy.json, read from policy.ts by its own directory) never
// reaches dist on its own. This copies every such file after the tsc step, no bundler.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [
  ['src/forge/model-policy.json', 'dist/forge/model-policy.json'],
];

for (const [from, to] of assets) {
  copyFileSync(join(root, from), join(root, to));
  console.log(`copied ${from} -> ${to}`);
}
