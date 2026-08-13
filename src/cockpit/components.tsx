/**
 * The screen.
 *
 * Every component here is a placement of values worked out in format.ts. The
 * one rule the layout enforces is that a guard objection and a degraded kernel
 * are never scrolled away or folded: an alarm nobody sees is the failure mode
 * this whole project exists to avoid.
 */
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';

import type { ApprovalRequest } from '../kernel/kernel.ts';
import type { GuardNote } from '../types.ts';
import type { Entry } from './entries.ts';
import { buildDiff, completions, toolSummary, type StatusBar as StatusBarModel } from './format.ts';

const STATUS_ICON: Record<string, string> = {
  pending: '·',
  running: '>',
  done: 'ok',
  error: '!!',
  denied: 'no',
};

export function StatusBarView({ bar }: { bar: StatusBarModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {bar.alarm ? (
        <Box>
          <Text color="black" backgroundColor="red" bold>
            {` ${bar.alarm} `}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color="cyan" bold>
          {bar.phase}
        </Text>
        <Text dimColor> · </Text>
        <Text color={bar.reroute ? 'red' : 'green'}>{bar.model}</Text>
        {bar.reroute ? (
          <>
            <Text dimColor> · </Text>
            <Text color="red" bold>
              {bar.reroute}
            </Text>
          </>
        ) : null}
        <Text dimColor> · </Text>
        <Text>{bar.mode}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>{bar.session}</Text>
        {bar.context ? <Text dimColor> · {bar.context}</Text> : null}
      </Box>
    </Box>
  );
}

function NoteView({ note }: { note: GuardNote }): React.ReactElement {
  const color =
    note.severity === 'blocking' ? 'red' : note.severity === 'warning' ? 'yellow' : 'blue';
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      <Text color={color}>
        <Text bold>[{note.guard}]</Text> {note.message}
      </Text>
    </Box>
  );
}

export function EntryView({ entry }: { entry: Entry }): React.ReactElement | null {
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            {'> '}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <Text dimColor italic>
            {entry.text.split('\n')[0]}
          </Text>
        </Box>
      );
    case 'tool': {
      const colour =
        entry.status === 'error' ? 'red' : entry.status === 'denied' ? 'yellow' : 'gray';
      return (
        <Box>
          <Text color={colour}>
            {' '}
            {STATUS_ICON[entry.status] ?? '·'} {toolSummary(entry.name, entry.input)}
          </Text>
        </Box>
      );
    }
    case 'note':
      return <NoteView note={entry.note} />;
    case 'system':
      return (
        <Box marginTop={1}>
          <Text
            color={entry.tone === 'error' ? 'red' : entry.tone === 'warn' ? 'yellow' : 'blue'}
          >
            {entry.text}
          </Text>
        </Box>
      );
    default:
      return null;
  }
}

export function StreamView({ entries }: { entries: Entry[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}

export function ApprovalView({
  request,
  onDecide,
  interactive = true,
}: {
  request: ApprovalRequest;
  onDecide: (allow: boolean) => void;
  /**
   * Off when there is no keyboard to read. Ink puts stdin into raw mode the
   * moment a key handler mounts, which throws outright when stdin is not a
   * terminal, so a screen that always listened could not be rendered anywhere
   * except a live session.
   */
  interactive?: boolean;
}): React.ReactElement {
  useInput(
    (input, key) => {
      const ch = input.toLowerCase();
      if (ch === 'y' || key.return) onDecide(true);
      if (ch === 'n' || key.escape) onDecide(false);
    },
    { isActive: interactive },
  );

  const blocking = request.notes.filter((n) => n.severity === 'blocking');
  const diff = request.isPlanApproval ? [] : buildDiff(request.call.toolName, request.call.input);
  const plan =
    typeof request.call.input['plan'] === 'string' ? (request.call.input['plan'] as string) : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={blocking.length ? 'red' : 'cyan'} paddingX={1}>
      <Text bold color={blocking.length ? 'red' : 'cyan'}>
        {request.isPlanApproval ? 'Approve this plan?' : `Run ${request.call.toolName}?`}
      </Text>

      {request.isPlanApproval && plan ? (
        <Box flexDirection="column" marginTop={1}>
          {plan.split('\n').slice(0, 40).map((line, i) => (
            // A blank line renders as nothing and the paragraph breaks vanish,
            // so an empty line keeps a space. A plan is being read here.
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      ) : null}

      {diff.length ? (
        <Box flexDirection="column" marginTop={1}>
          {diff.map((line, i) => (
            <Text
              key={i}
              color={line.kind === 'add' ? 'green' : line.kind === 'remove' ? 'red' : undefined}
              dimColor={line.kind === 'meta'}
            >
              {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}

      {request.notes.length ? (
        <Box flexDirection="column" marginTop={1}>
          {request.notes.map((note, i) => (
            <NoteView key={i} note={note} />
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>y approve · n reject</Text>
      </Box>
    </Box>
  );
}

export function InputLine({
  value,
  busy,
}: {
  value: string;
  busy: boolean;
}): React.ReactElement {
  const hints = completions(value);
  return (
    <Box flexDirection="column">
      {hints.length ? (
        <Box flexDirection="column">
          {hints.map((c) => (
            <Text key={c.name} dimColor>
              {'  '}
              {c.name.padEnd(10)} {c.help}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box>
        <Text color={busy ? 'yellow' : 'cyan'} bold>
          {busy ? '… ' : '> '}
        </Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}

/** Editable line, kept here so the app does not deal with key handling. */
export function useLineEditor(onSubmit: (text: string) => void, enabled: boolean) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);

  useInput(
    (input, key) => {
      if (key.return) {
        const text = value.trim();
        if (!text) return;
        setHistory((h) => [text, ...h]);
        setCursor(-1);
        setValue('');
        onSubmit(text);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        setCursor((c) => {
          const next = Math.min(c + 1, history.length - 1);
          if (next >= 0) setValue(history[next] ?? '');
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setCursor((c) => {
          const next = Math.max(c - 1, -1);
          setValue(next === -1 ? '' : (history[next] ?? ''));
          return next;
        });
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.escape) return;
      if (input) setValue((v) => v + input);
    },
    { isActive: enabled },
  );

  return { value, setValue };
}
