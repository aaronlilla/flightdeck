import type { JSX } from 'react';
/**
 * The console's root component.
 *
 * State comes from `/state` and `/inbox` on load and every 5s after (the
 * fallback), and is refreshed early whenever `/events` pushes something. The
 * WebSocket carries no state of its own: it is a signal to refetch, and its
 * own connect/close status drives the disconnected banner. That keeps one
 * source of truth for what is on screen instead of two that can disagree.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api.js';
import { CommandBar } from './components/CommandBar.js';
import { DisconnectedBanner } from './components/DisconnectedBanner.js';
import { InboxRail } from './components/InboxRail.js';
import { LanesGrid } from './components/LanesGrid.js';
import { TicketSheet } from './components/TicketSheet.js';
import type { ConnectionStatus, ForgeState, InboxState } from './types.js';
import { EventStream, type EventStreamOptions } from './ws.js';

const POLL_MS = 5000;

export interface AppProps {
  /** Overrides for tests: an EventStream that never touches a real socket. */
  eventStreamOptions?: EventStreamOptions;
}

export function App({ eventStreamOptions }: AppProps = {}): JSX.Element {
  const [state, setState] = useState<ForgeState | undefined>(undefined);
  const [inbox, setInbox] = useState<InboxState>({ open: [], all: [] });
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [stopping, setStopping] = useState(false);
  const [openRun, setOpenRun] = useState<string | undefined>(undefined);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextInbox] = await Promise.all([api.getState(), api.getInbox()]);
      if (!mounted.current) return;
      setState(nextState);
      setInbox(nextInbox);
      setLoadError(undefined);
    } catch (caught) {
      if (!mounted.current) return;
      setLoadError(caught instanceof Error ? caught.message : 'the fleet server is unreachable');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const stream = new EventStream(
      { onEvent: () => void refresh(), onStatusChange: setStatus },
      eventStreamOptions,
    );
    stream.start();

    const poll = setInterval(() => void refresh(), POLL_MS);

    return () => {
      mounted.current = false;
      stream.stop();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const onAnswer = useCallback(
    async (key: string, answerText: string) => {
      await api.answer(key, answerText);
      await refresh();
    },
    [refresh],
  );

  const onStop = useCallback(async () => {
    setStopping(true);
    try {
      await api.stopAll('stopped from the console');
      await refresh();
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'stop did not go through');
    } finally {
      setStopping(false);
    }
  }, [refresh]);

  const onSend = useCallback(
    async (run: string, text: string) => {
      await api.sendToRun(run, text);
      await refresh();
    },
    [refresh],
  );

  const onClear = useCallback(
    async (lane: string) => {
      await api.clearLane(lane);
      await refresh();
    },
    [refresh],
  );

  const onClearAsk = useCallback(
    async (key: string) => {
      await api.retireAsk(key);
      await refresh();
    },
    [refresh],
  );

  const onRoute = useCallback(
    async (text: string) => {
      const result = await api.sendToRouter(text);
      await refresh();
      return result;
    },
    [refresh],
  );

  const unreachable = status === 'closed' || Boolean(loadError);

  return (
    <div className="forge-app">
      <CommandBar
        state={state}
        disabledReason={unreachable ? 'the fleet server is unreachable' : undefined}
        onStop={() => void onStop()}
        stopping={stopping}
      />
      <DisconnectedBanner visible={unreachable} />
      <main className="forge-main">
        <LanesGrid
          lanes={state?.lanes.value ?? []}
          disabledReason={unreachable ? 'the fleet server is unreachable' : undefined}
          onSend={onSend}
          onClear={onClear}
          onOpen={setOpenRun}
        />
        <InboxRail
          open={inbox.open}
          onAnswer={onAnswer}
          onClearAsk={onClearAsk}
          routerEnabled={state?.router_enabled ?? false}
          onRoute={onRoute}
        />
      </main>
      {openRun ? <TicketSheet run={openRun} onClose={() => setOpenRun(undefined)} /> : null}
    </div>
  );
}
