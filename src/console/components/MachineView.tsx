import type { JSX } from 'react';

import { elapsedGlance } from '../../forge/console/laneGlance.js';
import { MACHINE_COMMAND_LINE_GLANCE_LENGTH } from '../../forge/machine/snapshot.js';
import type { MachineProcessRowView, MachineResponse, MachineSessionView } from '../api.js';

export interface MachineViewProps {
  machine: MachineResponse | null;
  verbose?: boolean;
  now?: number;
}

function displayCommandLine(commandLine: string, verbose: boolean): string {
  if (verbose || commandLine.length <= MACHINE_COMMAND_LINE_GLANCE_LENGTH) return commandLine;
  return `${commandLine.slice(0, MACHINE_COMMAND_LINE_GLANCE_LENGTH)}…`;
}

function ProcessRow({ node, depth, verbose }: { node: MachineProcessRowView; depth: number; verbose: boolean }): JSX.Element {
  return (
    <>
      <tr>
        <td style={{ paddingLeft: `${depth * 16}px` }}>{node.name}</td>
        <td>{Math.round(node.ageMs / 1000)}s</td>
        <td>{displayCommandLine(node.commandLine, verbose)}</td>
        <td>{node.output}</td>
      </tr>
      {node.children.map((child, i) => (
        <ProcessRow key={`${child.pid ?? child.name}-${i}`} node={child} depth={depth + 1} verbose={verbose} />
      ))}
    </>
  );
}

function SessionCard({ session, verbose, now }: { session: MachineSessionView; verbose: boolean; now: number }): JSX.Element {
  const elapsed = elapsedGlance(session.startedAt, now);
  return (
    <div className="machine-session-card">
      <div className="machine-session-header">
        <span>{session.name ?? session.repo ?? 'session'}</span>
        <span>{session.repo}</span>
        <span>{session.branch}</span>
        <span>{session.status}</span>
        {elapsed ? <span>{elapsed}</span> : null}
      </div>
      {session.root ? (
        <table>
          <tbody>
            <ProcessRow node={session.root} depth={0} verbose={verbose} />
          </tbody>
        </table>
      ) : (
        <div className="machine-session-empty">no live process</div>
      )}
    </div>
  );
}

export function MachineView({ machine, verbose = false, now = Date.now() }: MachineViewProps): JSX.Element {
  if (!machine) return <div className="machine-view">loading</div>;
  return (
    <div className="machine-view">
      <div className="machine-glance">{machine.glance}</div>
      <div className="machine-sessions">
        {machine.sessions.map((session, i) => (
          <SessionCard key={session.sessionId ?? session.name ?? i} session={session} verbose={verbose} now={now} />
        ))}
      </div>
      {machine.unregistered.length > 0 ? (
        <div className="machine-unregistered">
          <div className="machine-unregistered-label">not started by a session I know</div>
          <table>
            <tbody>
              {machine.unregistered.map((root, i) => (
                <ProcessRow key={`${root.pid ?? root.name}-${i}`} node={root} depth={0} verbose={verbose} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
