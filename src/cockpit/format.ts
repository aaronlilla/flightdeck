/**
 * Everything the interface displays, worked out as plain values.
 *
 * The components below this are thin on purpose. Terminal rendering is awkward
 * to assert against, so the decisions worth testing (what the status bar says,
 * whether a reroute is showing, how a diff reads) live here as functions over
 * data, and the React layer only places them on the screen.
 */
import { ALIAS_BY_TIER, MODEL_BY_TIER, type KernelHealth, type SessionState } from '../types.ts';

/** Short label for a model id, so the status bar stays one line. */
export function shortModel(model: string | null): string {
  if (!model) return 'unknown';
  const base = model.split('[')[0]?.trim() ?? model;
  for (const [tier, id] of Object.entries(MODEL_BY_TIER)) {
    if (base === id) return ALIAS_BY_TIER[tier as keyof typeof ALIAS_BY_TIER];
  }
  return base.replace(/^claude-/, '');
}

export interface StatusBar {
  phase: string;
  model: string;
  /** Set only when the answering model is not the one that was asked for. */
  reroute: string | null;
  mode: string;
  session: string;
  context: string | null;
  /** Set when enforcement is degraded, and never hidden while it is. */
  alarm: string | null;
}

export function buildStatusBar(
  state: SessionState,
  health: KernelHealth,
  contextRemaining: number | null,
): StatusBar {
  const selected = shortModel(state.selectedModel);
  const serving = shortModel(state.servingModel);
  const rerouted =
    state.selectedModel && state.servingModel && shortModel(state.selectedModel) !== serving;

  let alarm: string | null = null;
  if (!health.healthy) {
    alarm = `ENFORCEMENT UNCHECKED (${health.disabled.join(', ')})`;
  } else if (health.disabled.length > 0) {
    alarm = `guards off: ${health.disabled.join(', ')}`;
  }

  return {
    phase: state.phase,
    model: state.modelOverride ? `${selected} (pinned)` : selected,
    reroute: rerouted ? `serving ${serving}` : null,
    mode: state.permissionMode,
    session: state.sessionId ? state.sessionId.slice(0, 8) : 'new',
    context: contextRemaining === null ? null : `${Math.round(contextRemaining / 1000)}k left`,
    alarm,
  };
}

/** One line summarising a tool call, which expands on request. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash':
      return `${name}  ${firstLine(str('command'))}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${name}  ${str('file_path') || str('notebook_path')}`;
    case 'Agent': {
      const type = str('subagent_type') || 'agent';
      const model = str('model');
      return `${name}  ${type}${model ? ` on ${model}` : ''}`;
    }
    case 'Grep':
    case 'Glob':
      return `${name}  ${str('pattern')}`;
    default: {
      const first = Object.entries(input)[0];
      return first ? `${name}  ${first[0]}=${firstLine(String(first[1]))}` : name;
    }
  }
}

function firstLine(text: string, limit = 72): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'meta';
  text: string;
}

/**
 * A readable diff for the tools that write.
 *
 * Deliberately simple: the point is for a person to see what changes before
 * approving it, not to reproduce a diff algorithm. An edit shows what leaves
 * and what arrives; a whole-file write shows the opening lines and says how
 * much more there is.
 */
export function buildDiff(name: string, input: Record<string, unknown>, budget = 24): DiffLine[] {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

  if (name === 'Edit' || name === 'MultiEdit') {
    const before = str('old_string').split('\n');
    const after = str('new_string').split('\n');
    const lines: DiffLine[] = [{ kind: 'meta', text: str('file_path') }];
    for (const line of before.slice(0, budget)) lines.push({ kind: 'remove', text: line });
    if (before.length > budget) {
      lines.push({ kind: 'meta', text: `… ${before.length - budget} more removed` });
    }
    for (const line of after.slice(0, budget)) lines.push({ kind: 'add', text: line });
    if (after.length > budget) {
      lines.push({ kind: 'meta', text: `… ${after.length - budget} more added` });
    }
    return lines;
  }

  if (name === 'Write') {
    const content = str('content').split('\n');
    const lines: DiffLine[] = [
      { kind: 'meta', text: `${str('file_path')} (${content.length} lines)` },
    ];
    for (const line of content.slice(0, budget)) lines.push({ kind: 'add', text: line });
    if (content.length > budget) {
      lines.push({ kind: 'meta', text: `… ${content.length - budget} more lines` });
    }
    return lines;
  }

  if (name === 'Bash') {
    return str('command')
      .split('\n')
      .slice(0, budget)
      .map((text) => ({ kind: 'context' as const, text }));
  }

  return Object.entries(input)
    .slice(0, budget)
    .map(([key, value]) => ({ kind: 'context' as const, text: `${key}: ${firstLine(String(value))}` }));
}

/** Slash commands the app answers itself, rather than sending to the engine. */
export const LOCAL_COMMANDS: Array<{ name: string; help: string }> = [
  { name: '/plan', help: 'enter plan mode on the plan model' },
  { name: '/build', help: 'leave plan mode and return to ordinary work' },
  { name: '/model', help: 'pin a model, or clear the pin with /model auto' },
  { name: '/phase', help: 'show the current phase and what it requires' },
  { name: '/overlays', help: 'list the overlays this machine loaded' },
  { name: '/health', help: 'report which guards are running' },
  { name: '/resume', help: 'list recent sessions' },
  { name: '/clear', help: 'clear the visible conversation' },
  { name: '/quit', help: 'close flightdeck' },
];

export function completions(prefix: string): Array<{ name: string; help: string }> {
  if (!prefix.startsWith('/')) return [];
  const term = prefix.split(/\s+/)[0] ?? '';
  return LOCAL_COMMANDS.filter((c) => c.name.startsWith(term));
}
