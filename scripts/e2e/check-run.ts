// Prints the authoritative per-run state the journal itself computes (same `replay()`
// the server and `forge status` use), so the console's own numbers can be checked
// against it rather than against a second, hand-rolled reader.
import { replay } from '../../src/forge/journal.js';

const [, , journalPath, run] = process.argv;
if (!journalPath || !run) {
  console.error('usage: check-run.ts <journalPath> <run>');
  process.exit(2);
}
const state = replay(journalPath);
const row = state.runs[run];
console.log(JSON.stringify({ run, row: row ?? null, torn: state.torn }, null, 2));
