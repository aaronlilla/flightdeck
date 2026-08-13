/**
 * Standing order 15: a conclusion is not reached, it is survived.
 *
 * A plan has to name a rival account, say what would prove it wrong, and list
 * what it does not know. This guard reads the plan and reports which of the
 * three are missing.
 *
 * It differs from the Python version it replaces in one way that matters. The
 * hook could only refuse, so it denied the approval and the plan went back for
 * another pass. Here the objection travels with the plan to the approval
 * screen, placed against the thing it is about, and Aaron decides with it in
 * front of him. Refusing the approval was never the point. Being read was.
 */
import type { Guard, GuardDecision, GuardNote, ToolCall } from '../../types.ts';

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Below this many non-blank lines a plan is short, and a short plan gets advice
 * rather than an objection. Proportionality is doctrine: a typo fix does not
 * owe a full drill.
 */
const SHORT_PLAN_LINES = 40;

interface Requirement {
  key: string;
  label: string;
  re: RegExp;
  /** Characters of prose the section needs before it counts as answered. */
  floor: number;
  fix: string;
}

/**
 * The floors differ on purpose. A falsifier is one sentence by design, while a
 * list of alternatives that fits in forty characters is a gesture at having
 * considered something.
 */
const REQUIREMENTS: Requirement[] = [
  {
    key: 'alternatives',
    label: 'alternatives',
    re: /alternativ|rejected|other approach|approaches considered|options? (?:weighed|considered)|roads? not taken|why not\b|considered and/i,
    floor: 120,
    fix: 'Name at least one rival account and the observation that separates it from this one.',
  },
  {
    key: 'falsifier',
    label: 'falsifier',
    re: /falsifi|how (?:this|it|i) could be wrong|what would prove|prove(?:s|d)? (?:this|it) wrong|disconfirm|wrong if\b|invalidat|would kill this|abandon this if/i,
    floor: 40,
    fix: 'Write the one sentence: this is wrong if X. If you cannot, you hold a preference rather than a position.',
  },
  {
    key: 'unknowns',
    label: 'unknowns',
    re: /unknowns?\b|not verified|unverified|open questions?|untested|needs confirmation|assumptions?\b|have not (?:checked|verified)|did ?n[o']t (?:check|verify)/i,
    floor: 100,
    fix: 'State the unknowns by name. Silence about them reads as coverage that does not exist.',
  },
];

interface Section {
  heading: string;
  body: string;
}

/** Split a plan into headed sections, plus the text before the first heading. */
export function sections(text: string): Section[] {
  const out: Section[] = [];
  let heading = '';
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      out.push({ heading, body: body.join('\n') });
      heading = match[2] ?? '';
      body = [];
    } else {
      body.push(line);
    }
  }
  out.push({ heading, body: body.join('\n') });
  return out;
}

/** Paragraphs, for plans that argue in prose and never write a heading. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !HEADING.test(line))
    .join('\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function substance(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

export function contentLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * A requirement counts as answered by a heading with enough under it, or by a
 * paragraph that does the same work without announcing itself. The second path
 * is the one that matters: a guard that only recognised headings would teach
 * the author to write headings rather than to think.
 */
export function missingRequirements(plan: string): Requirement[] {
  const headed = sections(plan);
  const prose = paragraphs(plan);
  return REQUIREMENTS.filter((requirement) => {
    const byHeading = headed.some(
      (section) =>
        requirement.re.test(section.heading) && substance(section.body) >= requirement.floor,
    );
    if (byHeading) return false;
    const byProse = prose.some(
      (block) => requirement.re.test(block) && substance(block) >= requirement.floor,
    );
    return !byProse;
  });
}

export function reviewPlan(plan: string): GuardDecision {
  const missing = missingRequirements(plan);
  if (missing.length === 0) return { kind: 'pass' };

  const labels = missing.map((m) => m.label).join(', ');

  if (contentLines(plan) < SHORT_PLAN_LINES) {
    return {
      kind: 'annotate',
      notes: [
        {
          guard: 'convergence',
          severity: 'info',
          message:
            `This is a short plan (${contentLines(plan)} lines) and it does not carry: ${labels}. ` +
            'Not blocking, because proportionality is doctrine and a small change does not owe the full drill.',
        },
      ],
    };
  }

  const notes: GuardNote[] = missing.map((requirement) => ({
    guard: 'convergence',
    severity: 'blocking' as const,
    message: `No ${requirement.label}. ${requirement.fix}`,
  }));
  notes.unshift({
    guard: 'convergence',
    severity: 'blocking',
    message:
      `This plan does not carry: ${labels}. Standing order 15 asks for them before a plan is ` +
      'acted on. Inventing a decoy alternative to clear this is worse than leaving it missing.',
  });
  return { kind: 'annotate', notes };
}

export const convergenceGuard: Guard = {
  name: 'convergence',

  decide(call: ToolCall): GuardDecision {
    if (call.toolName !== 'ExitPlanMode') return { kind: 'pass' };
    const plan = typeof call.input['plan'] === 'string' ? call.input['plan'] : '';
    if (!plan) {
      return {
        kind: 'annotate',
        notes: [
          {
            guard: 'convergence',
            severity: 'blocking',
            message:
              'No plan text was available to check, so whether it carries alternatives, a ' +
              'falsifier and unknowns is unknown. Unknown is not passing.',
          },
        ],
      };
    }
    return reviewPlan(plan);
  },
};
