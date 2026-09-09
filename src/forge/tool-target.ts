/**
 * One line per tool call, for a person or a judge reading a run's recent activity.
 *
 * The journal's `tool.start` row carries the tool name and, when the input names one, a
 * target: the file for a file tool, the pattern for a search, the first line of a shell
 * command. The warden's conformance judge reads these rows, and a name alone ("Edit, Edit,
 * Bash") gives it nothing to hold against the brief. Never the whole input: a Write carries
 * a file's contents, and that belongs in no summary row.
 */
const MAX_TARGET = 100;

const FILE_KEYS = ['file_path', 'path', 'notebook_path'] as const;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET - 1)}…` : line;
}

/** The target of a tool call, or `undefined` when the input names none. */
export function toolTarget(name: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (name === 'Bash' && typeof input['command'] === 'string') return firstLine(input['command']);
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length) return firstLine(value);
  }
  if ((name === 'Grep' || name === 'Glob') && typeof input['pattern'] === 'string') return firstLine(input['pattern']);
  if (name === 'Agent' && typeof input['description'] === 'string') return firstLine(input['description']);
  if (name === 'Skill' && typeof input['skill'] === 'string') return firstLine(input['skill']);
  return undefined;
}

/** `Edit src/x.ts` or `Bash: npm test`, from a journal row's `tool` and `target`. */
export function renderToolCall(tool: string, target: string | undefined): string {
  if (!target) return tool;
  return tool === 'Bash' ? `${tool}: ${target}` : `${tool} ${target}`;
}
