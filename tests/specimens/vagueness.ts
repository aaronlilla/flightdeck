/**
 * Vagueness specimens, ported from the Python suite.
 *
 * Standing order 17: an underspecified request gets questions, never a guess.
 *
 * These specimens cover stage one only, which is the pure part: does this
 * prompt even deserve a second look. Stage two asks a model to classify the
 * prompt and costs a call, so it is injected rather than wired in, and the
 * corpus proves the cheap filter instead of paying to test the expensive one.
 *
 * Stage one is where nearly all the value sits anyway. Every false positive it
 * lets through becomes an interview Aaron did not ask for, which is the failure
 * that gets a gate switched off.
 */
import type { Specimen } from './types.ts';

/** Stage one either sends the prompt onward or explains why it did not. */
export type PrefilterVerdict = 'classify' | 'skip';

export const FEATURE_PROMPT =
  'make the notification system better for the users who have been complaining about it recently';
export const RESEARCH_ASK =
  'do research on what we can do with gambling features in our application and what the rules are';

export const VAGUENESS_SPECIMENS: Array<Specimen<string, PrefilterVerdict>> = [
  // --- must reach the classifier ------------------------------------------
  { name: 'vague improvement request', input: 'make the deposit flow better', expect: 'classify' },
  { name: 'vague performance request', input: 'make it faster', expect: 'classify' },
  { name: 'vague cleanup request', input: 'clean up the wallet code', expect: 'classify' },
  { name: 'vague quality request', input: 'improve error handling', expect: 'classify' },
  { name: 'long vague feature request', input: FEATURE_PROMPT, expect: 'classify' },
  {
    name: 'research request with no frame',
    input: RESEARCH_ASK,
    expect: 'classify',
    why: 'A research verb is a work order. The wrong frame silently discards right answers.',
  },
  {
    name: 'research request naming no market or version',
    input: 'research the options for expanding what our players can bet on',
    expect: 'classify',
  },
  {
    name: 'investigation request with no environment named',
    input: 'investigate whether we can offer live betting to our players',
    expect: 'classify',
  },

  // --- must be skipped -----------------------------------------------------
  {
    name: 'control: escape hatch prefix',
    input: `~~ ${FEATURE_PROMPT}`,
    expect: 'skip',
    why: 'Aaron opts out of the interview for one turn.',
  },
  { name: 'control: slash command', input: '/model opus', expect: 'skip' },
  { name: 'control: bang command', input: '!git status --short', expect: 'skip' },
  { name: 'control: continuation', input: 'ok continue', expect: 'skip' },
  {
    name: 'control: a question rather than a work order',
    input: 'how does the retry helper decide when to give up?',
    expect: 'skip',
  },
  {
    name: 'control: vague wording inside a question',
    input: 'should I make the notification system better for everyone?',
    expect: 'skip',
    why: 'The trailing question mark means he is asking, not ordering.',
  },
  {
    name: 'control: request anchored to a file path',
    input: 'fix the off-by-one in src/features/wallet/deposit.ts before we ship it',
    expect: 'skip',
  },
  {
    name: 'control: request anchored by a backticked identifier',
    input: 'rename `computeFeeTotal` to something that says what it actually returns',
    expect: 'skip',
  },
  {
    name: 'control: request carrying a pasted error',
    input: 'make this go away please: TypeError: cannot read property id of undefined',
    expect: 'skip',
  },
  {
    name: 'control: an observation with no build verb',
    input: 'the notification system has been annoying everyone on the team for months',
    expect: 'skip',
  },
  { name: 'control: short specific fix', input: 'fix the typo', expect: 'skip' },
  { name: 'control: short revert', input: 'revert that', expect: 'skip' },
  { name: 'control: short version bump', input: 'bump the version', expect: 'skip' },
  {
    name: 'control: short rename naming the target',
    input: 'rename it to formatMillicents',
    expect: 'skip',
  },
  {
    name: 'control: research request already anchored to a file',
    input: 'research why src/app/baseQuery.ts swallows the soft-200 case',
    expect: 'skip',
  },
  { name: 'control: bare assent', input: 'do it', expect: 'skip' },
  {
    name: 'control: wrapper-only prompt',
    input: '<command-name>/model</command-name><command-message>model</command-message>',
    expect: 'skip',
    why: 'Slash command stdout is not Aaron speaking.',
  },
];
