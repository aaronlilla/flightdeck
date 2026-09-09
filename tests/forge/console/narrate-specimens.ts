/**
 * Twenty fact records, one per narrated surface shape the console actually builds.
 *
 * They are the live proof's input and nothing else: `scripts/narrate-proof.ts` runs the
 * real model over them on a throwaway FORGE_HOME and prints all three registers plus the
 * checker's verdict for each. Kept beside the suite rather than in `scripts/` because
 * they are specimens, and a specimen that drifts from the builders it stands for is worth
 * nothing -- every record here is the shape the named builder emits.
 */
import type { NarrationFacts } from '../../../src/shared/console-model.js';

export const SPECIMENS: NarrationFacts[] = [
  // laneGlance.ts#didFactsFor
  { surface: 'lane.did', facts: { lane: 'NWR-96', pr: 412, checks: 'passed', verdict: 'approved', state: 'done' },
    template: 'Checks passed and the council approved PR #412.' },
  { surface: 'lane.did', facts: { lane: 'NWR-178', pr: 501, checks: 'failing' },
    template: 'Opened PR #501; checks are failing.' },
  { surface: 'lane.did', facts: { lane: 'NWR-233' },
    template: 'Read the brief and started on the first change.' },
  // plain.ts#plainFactsFor
  { surface: 'lane.now', facts: { lane: 'NWR-96', model: 'Sonnet', started: '09:15' },
    template: 'Working since 09:15 on a Sonnet session.' },
  { surface: 'lane.now', facts: { lane: 'NWR-226', state: 'parked' },
    template: 'Parked: waiting on you.' },
  { surface: 'lane.now', facts: { lane: 'NWR-155', state: 'blocked', pr: 340 },
    template: 'Blocked on PR #340.' },
  // laneGlance.ts#youFactsFor
  { surface: 'lane.you', facts: { lane: 'NWR-96', pr: 412 },
    template: 'Review PR #412 and merge it.' },
  { surface: 'lane.you', facts: { lane: 'NWR-178', state: 'blocked' },
    template: 'Nothing right now; it is blocked on an integration.' },
  // summary.ts#computeLaneSummary
  { surface: 'summary.what', facts: { lane: 'NWR-96', pr: 412 },
    template: 'Adds the narration layer. Opened PR #412.' },
  { surface: 'summary.next', facts: { lane: 'NWR-233', ahead: 2 },
    template: 'Starts after 2 more finish.' },
  // queue-route.ts#queueOrderWordsWith
  { surface: 'queue.whyNext', facts: { position: 1, source: 'Ready for Dev' },
    template: 'First in the queue, from a ticket in Ready for Dev.' },
  { surface: 'queue.whyNext', facts: { position: 3, source: 'brief' },
    template: 'Third in the queue, from a brief.' },
  { surface: 'queue.startsIn', facts: { state: 'queued' },
    template: 'Starts when a slot frees up.' },
  // blockers.ts#blockerFactsFor
  { surface: 'blocker.title', facts: { state: 'open' },
    template: 'Sentry is not connecting.' },
  { surface: 'blocker.detail', facts: { pr: 501 },
    template: 'PR #501 on aaronlilla/flightdeck has failing checks.' },
  { surface: 'blocker.howToResolve', facts: { who: 'Joe' },
    template: 'Nudge Joe -- there is nothing to click here.' },
  { surface: 'blocker.thenWhat', facts: { pr: 340 },
    template: 'Re-runs the checks on PR #340.' },
  { surface: 'blocker.whoNote', facts: {},
    template: 'outside vendor; you hold the card' },
  // thread-narrate.ts#railFactsFor
  { surface: 'rail.event', facts: { time1: '09:15' },
    template: 'Started on Sonnet at 09:15' },
  { surface: 'rail.activity', facts: { time1: '09:15', time2: '09:41' },
    template: 'Worked 09:15 to 09:41: read 12 files, ran 3 commands' },
];
