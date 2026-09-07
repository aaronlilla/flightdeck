/**
 * Which `exec.ts` budget class a shell command belongs to, read off its text.
 *
 * The warden judges a tool call in flight against its class's wall budget
 * (`liveness.ts`). Until 2026-09-07 every `tool.start` row carried no class, so every
 * Bash call was measured against `script`'s 120 s and a backend worker was parked for
 * a `dotnet build` that was merely slow. The worker classifies the command when it
 * starts, the journal carries the class, and the warden reads it back.
 *
 * A chained command takes the heaviest class of its parts: `npm ci && npm test` is a
 * test run that happens to install first.
 */
import { DEFAULT_CLASS } from './exec.js';

const RANK: Record<string, number> = { script: 0, install: 1, test: 2, build: 3 };

const PATTERNS: Array<[cls: string, re: RegExp]> = [
  ['build', /\b(dotnet\s+(build|publish)|msbuild|gradlew?\b|gradle\b|tsc\b|vite\s+build|webpack|esbuild|cargo\s+build|go\s+build|eas(-cli)?\s+build|npm\s+run\s+(build|dist|verify|typecheck)|xcodebuild)\b/],
  ['test', /\b(jest|vitest|mocha|pytest|dotnet\s+test|playwright\s+test|cargo\s+test|go\s+test|npm\s+(test|run\s+test[\w:-]*)|gradle\w*\s+test|maestro)\b/],
  ['install', /\b(npm\s+(ci|install|i)\b|yarn(\s+install)?\b|pnpm\s+(install|i)\b|pip\s+install|dotnet\s+restore|nuget\s+restore|bundle\s+install|pod\s+install|cargo\s+fetch)/],
];

export function classifyCommand(command: string): string {
  let best = DEFAULT_CLASS;
  for (const part of command.split(/&&|\|\||;|\|/)) {
    for (const [cls, re] of PATTERNS) {
      if (re.test(part) && (RANK[cls] ?? 0) > (RANK[best] ?? 0)) best = cls;
    }
  }
  return best;
}
