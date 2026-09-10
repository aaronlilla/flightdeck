/**
 * Messages queued for a hand-opened terminal, delivered on its next `UserPromptSubmit`.
 *
 * Same shape as `runinbox.ts`'s `RunInbox` (a worker's own inbox), kept as a separate
 * file rather than a shared base class: a session message is drained and deleted by
 * `GET /sessions/:id/inbox` in one call (the hook pulls, sees the text, moves on), where
 * `RunInbox.all()` leaves messages on disk and marks them read -- two different delivery
 * contracts that would only fight each other inside one class.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { forgeHome } from '../paths.js';

export interface SessionMessage {
  id: string;
  at: number;
  seq: number;
  from: string;
  text: string;
}

/** A session id reaches here straight from a URL path segment
 *  (`POST /sessions/:id/message`, `GET /sessions/:id/inbox`), decoded but never
 *  otherwise checked -- this is the one gate standing between that and a path that
 *  escapes `session-inbox/`. Real session ids are UUIDs; nothing legitimate needs a
 *  path separator or a `.`. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function sessionInboxDir(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`refusing an unsafe session id: ${JSON.stringify(sessionId)}`);
  }
  return join(forgeHome(), 'session-inbox', sessionId);
}

export class SessionInbox {
  private readonly dir: string;

  constructor(private readonly sessionId: string, baseDir: string = sessionInboxDir(sessionId)) {
    this.dir = baseDir;
  }

  queue(text: string, from: string): SessionMessage {
    mkdirSync(this.dir, { recursive: true });
    const sequence = existsSync(this.dir)
      ? readdirSync(this.dir).filter((name) => name.endsWith('.json')).length
      : 0;
    const message: SessionMessage = { id: randomUUID(), at: Date.now(), seq: sequence, from, text };
    writeFileSync(
      join(this.dir, `${String(message.at).padStart(16, '0')}-${String(sequence).padStart(6, '0')}-${message.id}.json`),
      JSON.stringify(message, null, 2), 'utf8',
    );
    return message;
  }

  /** Every pending message, oldest first, deleted from disk as it is read -- delivery
   *  is exactly-once, the way `UserPromptSubmit`'s pull needs it to be. */
  drain(): SessionMessage[] {
    if (!existsSync(this.dir)) return [];
    const names = readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
    const messages: SessionMessage[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        messages.push(JSON.parse(readFileSync(path, 'utf8')) as SessionMessage);
      } catch {
        // A half-written file loses that one message rather than the whole drain.
      }
      unlinkSync(path);
    }
    return messages;
  }
}
