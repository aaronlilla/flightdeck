/**
 * Requirement 4, voice half: every Jira write goes out in Aaron's voice. This is Intake's
 * own proven detector (order 2), narrower than the machine-wide
 * `~/.claude/hooks/authorship_guard.py` it deliberately mirrors: third-person "Aaron ..."
 * narration and first-person agent/session self-narration are both denied before a
 * write ever reaches `externalWrite.ts`'s sink.
 *
 * `naiveSkipGuard` is the red specimen this stream watched fail: a stub that always
 * passes, kept here so the test file that exercises it can prove the real guard is doing
 * work rather than merely existing.
 */
export interface VoiceVerdict {
  ok: boolean;
  reason?: string;
}

export function naiveSkipGuard(_text: string): VoiceVerdict {
  return { ok: true };
}

const THIRD_PERSON_AARON = /\bAaron\b[^.?!]{0,40}\b(reported|said|wrote|found|noted|asked|filed)\b/i;
const SESSION_NARRATION = /\b(this session|as an ai|as an assistant|i searched the codebase)\b/i;

export function voiceGuard(text: string): VoiceVerdict {
  const thirdPerson = THIRD_PERSON_AARON.exec(text);
  if (thirdPerson) {
    return { ok: false, reason: `Aaron named in the third person: "${thirdPerson[0]}"` };
  }
  const narration = SESSION_NARRATION.exec(text);
  if (narration) {
    return { ok: false, reason: `agent/session self-narration: "${narration[0]}"` };
  }
  return { ok: true };
}
