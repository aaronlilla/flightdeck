/**
 * Vagueness rule specimens, adapted from tests/specimens/vagueness.ts to
 * `ProposedAction`'s `reply` shape: a reply that proposes further work (a handoff, a
 * fix-round instruction) is denied when it names a quality goal with no anchor to make
 * it concrete, same stage-one filter the kernel guard already proves.
 */
import type { Specimen } from './gitflow.ts';

const FEATURE_PROMPT =
  'make the notification system better for the users who have been complaining about it recently';

export const VAGUENESS_SPECIMENS: Specimen[] = [
  { name: 'vague improvement instruction', input: { kind: 'reply', text: 'make the deposit flow better' }, expect: 'deny' },
  { name: 'vague performance instruction', input: { kind: 'reply', text: 'make it faster' }, expect: 'deny' },
  { name: 'vague cleanup instruction', input: { kind: 'reply', text: 'clean up the wallet code' }, expect: 'deny' },
  { name: 'long vague feature instruction', input: { kind: 'reply', text: FEATURE_PROMPT }, expect: 'deny' },
  {
    name: 'control: instruction anchored to a file and line',
    input: { kind: 'reply', text: 'fix the null check in src/api.ts:42' },
    expect: 'allow',
  },
  {
    name: 'control: instruction anchored to a stack trace',
    input: { kind: 'reply', text: 'fix the TypeError thrown in the retry handler, see stack trace above' },
    expect: 'allow',
  },
  { name: 'control: a plain continuation, not an instruction', input: { kind: 'reply', text: 'ok, go ahead' }, expect: 'allow' },
  { name: 'control: a factual reply with no quality word', input: { kind: 'reply', text: 'the judge returned PASS' }, expect: 'allow' },
];
