/**
 * The live proof: the real model, over the twenty specimens, on a throwaway FORGE_HOME.
 *
 * Everything else in this layer is proven against an injected `queryFn`, which proves the
 * wiring and nothing about whether a real model can write a sentence the checker will
 * accept. This script is the only place that question is answered, so it is deliberately
 * not a test: it costs real calls, and it runs when a person asks for it.
 *
 * It prints, per specimen, all three registers and the checker's verdict; then it runs a
 * second pass over the same home and counts `reasoner.call` rows of class `narrate` off
 * the journal. Twenty on the first pass and zero on the second is the claim.
 *
 *   npx tsx scripts/narrate-proof.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/forge/journal.js';
import { reasonerFor } from '../src/forge/reasoner-claude.js';
import { narrationKey } from '../src/forge/console/narrate.js';
import { NarrationStore, Narrator } from '../src/forge/console/narrate-store.js';
import { SPECIMENS } from '../tests/forge/console/narrate-specimens.js';

const home = mkdtempSync(join(tmpdir(), 'forge-narrate-proof-'));
const journalPath = join(home, 'fleet.jsonl');

function narrateCalls(): number {
  let text = '';
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row['event'] === 'reasoner.call' && row['class'] === 'narrate').length;
}

function narratorFor(): Narrator {
  const journal = new Journal(journalPath);
  return new Narrator({
    reasoner: reasonerFor('claude', { journal, cwd: process.cwd() }),
    journal, home, concurrency: 2,
  });
}

async function main(): Promise<void> {
  console.log(`FORGE_HOME copy: ${home}`);
  console.log(`specimens: ${SPECIMENS.length}\n`);

  const first = narratorFor();
  for (const specimen of SPECIMENS) first.get(specimen);
  await first.idle();

  const store = new NarrationStore(home);
  let accepted = 0;
  for (const specimen of SPECIMENS) {
    const key = narrationKey(specimen);
    const entry = store.get(key);
    const narrated = first.get(specimen);
    console.log(`--- ${specimen.surface}  key ${key.slice(0, 12)}`);
    console.log(`  glance: ${narrated.glance}`);
    console.log(`  detail: ${narrated.detail}`);
    console.log(`  raw:    ${narrated.raw.split('\n').join(' | ')}`);
    const verdict = entry?.verdict;
    if (verdict?.ok) accepted += 1;
    console.log(`  checker: ${verdict ? (verdict.ok ? 'accepted' : `rejected ${verdict.rule} ${verdict.token ?? ''} in ${verdict.register ?? ''} -- ${verdict.reason}`) : 'no entry (served the template)'}\n`);
  }

  const afterFirst = narrateCalls();
  console.log(`accepted by the checker: ${accepted}/${SPECIMENS.length}`);
  console.log(`reasoner.call rows, class narrate, first pass: ${afterFirst}`);

  const second = narratorFor();
  for (const specimen of SPECIMENS) second.get(specimen);
  await second.idle();
  console.log(`reasoner.call rows added by the second pass: ${narrateCalls() - afterFirst}`);
}

void main();
