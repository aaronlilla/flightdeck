/** What the conversation stream holds. */
import type { GuardNote } from '../types.ts';

export type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'thinking'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      toolId: string;
      name: string;
      input: Record<string, unknown>;
      status: 'pending' | 'running' | 'done' | 'error' | 'denied';
      result?: string;
    }
  | { kind: 'note'; id: number; note: GuardNote }
  | { kind: 'system'; id: number; text: string; tone: 'info' | 'warn' | 'error' };

let counter = 0;
export const nextId = (): number => (counter += 1);
