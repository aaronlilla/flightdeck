# Spec: equal-priority Jira intake with a gauntlet loop

Aaron, 2026-09-18:

> i want to make sure that we have a system built into flightdeck that polls at a time
> interval for new jira tickets assigned to me, or comments directed at me or in my
> general direction, and treats them both as the same importance to complete end to end,
> with the tickets having to go through the full planning and implementation to PR/merge
> phases, and the tickets going through this exact same gauntlet loop style process,
> which should result in a response or a response + reassign the ticket to myself if we
> can handle the ticket, and then the ticket goes through the obvious flows that i've
> already said

## What exists today

Two pollers already run, and they are not peers.

- `watcherWire.ts` + `watcher-state.ts` poll `watcherJql(project, ownedKeys)`: tickets
  already assigned to Aaron and not Done. A hit becomes a queue item, and `queue.ts`
  carries it through plan, implement, PR, gate, merge.
- `sync/feed-wire.ts` + `jiraFeed.ts` poll comments. A hit becomes a reply, a send to a
  live lane, or a question in the inbox. A comment can never become work.

So a ticket assigned to Aaron goes end to end, and a comment asking Aaron to do exactly
the same piece of work stops at a reply. That asymmetry is what this spec removes.

Neither path runs a gauntlet. `replyRefusal` is a mechanical gate (length, voice, banned
words, humanizer rule); it has no notion of whether the reply is any good, and one
rewording is the entire retry budget.

## What to build

### 1. `replyGauntlet.ts`, the loop

A builder drafts, a separate critic with its own prompt judges, the builder rewrites,
repeat until the critic picks ours or the round cap is hit. The critic never sees the
builder's reasoning, only the drafted text, the thread, and the bar.

The bar is real: recent comments by other people on the same board, which the feed can
already read. Never a description of a voice, always the actual comments.

The critic answers three things and nothing else: which of the two reads like a teammate
who read the ticket (`ours` or `theirs`), whether every claim in the draft is supported
by the thread it was given, and the single biggest remaining gap. A score out of ten
drifts upward every round; a binary choice does not.

Exit is winning, not a round count. The round cap exists only so a loop cannot run
forever, and hitting it is a deferral to the inbox, never a post.

### 2. `ticketClaim.ts`, the decision

For every candidate the feed finds, and for every new ticket the watcher finds, one
bounded call decides whether this is work FlightDeck can take:

- `claim`: it is a concrete change in a repo we own, the ask is clear enough to plan
  against, and no decision only Aaron can make is pending. Reply, assign the ticket to
  Aaron, and queue it.
- `answer`: it is a question, and the answer is the whole of it. Reply only.
- `defer`: it needs Aaron. Draft the reply anyway and raise it in the inbox.

A claim does three writes in this order, and stops at the first failure: post the reply,
assign to Aaron, enqueue. Posting first means a failed assign leaves a visible comment
rather than a silent reassignment; enqueueing last means the queue never owns a ticket
the board does not show as Aaron's.

Claiming is capped per pass and per hour. An unbounded claim loop on a busy board is how
this feature turns into thirty lanes nobody asked for.

### 3. Equal priority

Both sources feed one intake. Same poll interval, same cadence, one shared cap, and a
comment-born claim enters `queue.ts` as the same `ticket` item an assigned ticket
produces, so plan, implement, PR, gate and merge are literally the same code path. There
is no second pipeline to keep in sync, which is the point.

## Rules that still bind

Everything in `BRIEF.md` binds on every posted reply: Aaron is the author, casual
register, no em dash, no banned word, 160 characters of prose, 80 words, no agent
narration. The gauntlet sits in front of those gates, it does not replace them: a reply
that wins the loop and then fails `replyRefusal` is still refused.

## Out of scope

Merging. `queue.ts` already owns that, and the hold labels already decide which tickets
stop at a pull request.
