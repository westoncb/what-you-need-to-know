// flow-observer.ts - ES Module version

export type FlowEvent =
  | { t: 'stage_start'; id: string; name: string; kind: 'cpu' | 'llm'; cfg: Record<string, unknown> }
  | { t: 'stage_end';   id: string; ok: boolean; elapsed: number }
  | { t: 'item_update'; stage: string; idx: number; state: 'queued' | 'run' | 'done' | 'error' }
  | Snapshot;

export interface Snapshot {
  t: 'snapshot';
  ts: number;
  stages: Record<string, StageSnapshot>;
}

export interface StageSnapshot {
  name     : string;
  kind     : 'cpu' | 'llm';
  cfg      : Record<string, unknown>;
  status   : 'idle' | 'running' | 'done' | 'error';
  totals   : { in: number; out: number; err: number };
  inFlight : number;
  inputs   : unknown[];   // recent N
  outputs  : unknown[];   // recent N
}

export type FlowLogger = (e: FlowEvent) => void;

/* ------------------------------------------------------------------ */
/* Ring buffer helper                                                 */
/* ------------------------------------------------------------------ */
class Ring<T> {
  private buf: T[];
  private idx = 0;
  constructor(private readonly size: number) { this.buf = new Array(size); }
  push(x: T) {
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.size;
  }
  toArray(): T[] {
    // return in insertion order (oldest→newest)
    const out: T[] = [];
    for (let i = 0; i < Math.min(this.size, this.buf.filter(v=>v!==undefined).length); i++) {
      out.push(this.buf[(this.idx + i) % this.size]);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Internal bookkeeping                                               */
/* ------------------------------------------------------------------ */
interface StageState extends StageSnapshot {
  inputsRing : Ring<unknown>;
  outputsRing: Ring<unknown>;
}

const STAGES = new Map<string, StageState>();
let sid = 0;                                 // stage id counter

/* ------------------------------------------------------------------ */
/* Logger & snapshot timer                                            */
/* ------------------------------------------------------------------ */
let _logger: FlowLogger | null = null;
let snapTimer: NodeJS.Timeout | null = null;
let SNAP_MS = 0;
let RING_SIZE = 10;

export function setLogger(
  fn: FlowLogger | null,
  opts: { snapshotMs?: number; ringSize?: number } = {}
) {
  _logger = fn;
  if (snapTimer) clearInterval(snapTimer), (snapTimer = null);
  SNAP_MS = opts.snapshotMs ?? SNAP_MS;
  RING_SIZE = opts.ringSize ?? RING_SIZE;
  if (fn && SNAP_MS > 0) {
    snapTimer = setInterval(() => emitSnapshot(), SNAP_MS);
    // don't keep Node alive just for the timer
    snapTimer.unref?.();
  }
}

function log(e: FlowEvent) {
  if (_logger) {
    try {
      _logger(e);
    } catch (err) {
      console.error("[Flow] Error in logger:", err);
    }
  }
}

function emitSnapshot() {
  const stages: Record<string, StageSnapshot> = {};
  for (const [id, s] of STAGES) {
    stages[id] = {
      name   : s.name,
      kind   : s.kind,
      cfg    : s.cfg,
      status : s.status,
      totals : { ...s.totals },
      inFlight: s.inFlight,
      inputs : s.inputsRing.toArray(),
      outputs: s.outputsRing.toArray(),
    };
  }
  log({ t: 'snapshot', ts: Date.now(), stages });
}

/* ------------------------------------------------------------------ */
/* Stage type and instrument decorator                                 */
/* ------------------------------------------------------------------ */
// We replicate the Stage signature locally to avoid circular import.
export type Stage<I, O> = (src: AsyncIterable<I>, opts?: unknown) => AsyncIterable<O>;

export function instrument<I, O>(
  name: string,
  kind: 'cpu' | 'llm',
  cfg: Record<string, unknown>,
  inner: Stage<I, O>,
): Stage<I, O> {
  const id = `S${sid++}`;

  STAGES.set(id, {
    name,
    kind,
    cfg,
    status   : 'idle',
    totals   : { in: 0, out: 0, err: 0 },
    inFlight : 0,
    inputsRing : new Ring(RING_SIZE),
    outputsRing: new Ring(RING_SIZE),
    inputs   : [],
    outputs  : [],
  } as any);

  return async function* (src: AsyncIterable<I>, opts?: unknown): AsyncIterable<O> {
    const S = STAGES.get(id)!;
    const start = Date.now();
    S.status = 'running';
    log({ t: 'stage_start', id, name, kind, cfg });

    let idx = 0;
    try {
      for await (const item of src) {
        const ix = idx++;
        S.totals.in++;
        S.inputsRing.push(item);
        S.inFlight++;
        log({ t: 'item_update', stage: id, idx: ix, state: 'run' });

        let out: O | undefined;
        let errored = false;
        try {
          for await (const o of inner((async function*(){ yield item; })(), opts)) {
            out = o;
            break; // inner should yield at most one for single-item feed
          }
        } catch (e) {
          errored = true;
          S.totals.err++;
          S.status = 'error';
          log({ t: 'item_update', stage: id, idx: ix, state: 'error' });
          throw e;
        } finally {
          S.inFlight--;
        }

        if (!errored && out !== undefined) {
          S.totals.out++;
          S.outputsRing.push(out);
          log({ t: 'item_update', stage: id, idx: ix, state: 'done' });
          yield out;
        }
      }
      if (S.status !== 'error') S.status = 'done';
      log({ t: 'stage_end', id, ok: S.status !== 'error', elapsed: Date.now() - start });
    } finally {
      // On generator close (e.g., external cancel) reflect status
      if (S.status === 'running') S.status = 'done';
    }
  };
}

export function instrumentBatch<I,O>(
  name : string,
  kind : 'cpu'|'llm',
  cfg  : Record<string,unknown>,
  inner: Stage<I,O>,
): Stage<I,O> {

  const id = `S${sid++}`;

  STAGES.set(id, {
    name,
    kind,
    cfg,
    status   : 'idle',
    totals   : { in: 0, out: 0, err: 0 },
    inFlight : 0,
    inputsRing : new Ring(RING_SIZE),
    outputsRing: new Ring(RING_SIZE),
    inputs   : [],
    outputs  : [],
  } as any);

  return async function* (src: AsyncIterable<I>, opts?: unknown) {
    const S = STAGES.get(id)!;
    const t0 = Date.now();
    S.status = 'running';
    log({ t:'stage_start', id, name, kind, cfg });

    // We pass the *real* src into inner unchanged
    let idx = 0;
    try {
      for await (const out of inner(src, opts)) {
        S.totals.out++;        S.outputsRing.push(out);
        log({ t:'item_update', stage:id, idx:idx++, state:'done' });
        yield out;
      }
      S.status = 'done';
    } catch (e) {
      S.status = 'error';      S.totals.err++;
      throw e;
    } finally {
      log({ t:'stage_end', id, ok:S.status!=='error', elapsed:Date.now()-t0 });
    }
  };
}

/* ====================================================================
   Default WebSocket logger
   --------------------------------------------------------------------
   Usage:
     import { setLogger, makeWsLogger } from "./flow-observer.js";

     setLogger(
       makeWsLogger({ url: "ws://localhost:4000", mirror: true }),
       { snapshotMs: 500, ringSize: 20 }
     );
==================================================================== */

interface WsLoggerOpts {
  /** e.g. "ws://localhost:4000" (default) */
  url?: string;
  /** whether to console.log every event as a backup */
  mirror?: boolean;
  /** reconnect delay ms */
  retryMs?: number;
}

export function makeWsLogger(
  opts: WsLoggerOpts = {}
): FlowLogger {

  const {
    url     = "ws://localhost:4000",
    mirror  = false,
    retryMs = 2_000,
  } = opts;

  let ws: any = null; // Using 'any' to accommodate various WebSocket implementations
  let queue: string[] = [];
  let connecting = false;
  let WebSocketImpl: any;
  let connectionAttempts = 0;
  const MAX_CONNECTION_ATTEMPTS = 3; // Limit retry attempts
  let wsImportFailed = false;

  // Initialize WebSocket implementation immediately
  try {
    // For Node.js ESM, we need to use a dynamic import but handle it synchronously for the logger
    import('ws').then(wsModule => {
      WebSocketImpl = wsModule.default || wsModule.WebSocket;
      console.log("[Flow] Successfully imported WebSocket implementation for Node.js");
      // Connect once we have the implementation
      connect();
    }).catch(err => {
      wsImportFailed = true;
      console.error("[Flow] Failed to import WebSocket, will use console logging only:", err.message);
    });
  } catch (err) {
    wsImportFailed = true;
    console.error("[Flow] Failed to initialize WebSocket import, will use console logging only:", err);
  }

  function connect() {
    if (connecting || !WebSocketImpl || connectionAttempts >= MAX_CONNECTION_ATTEMPTS) return;

    connecting = true;
    connectionAttempts++;

    try {
      // Only log on first attempt to avoid spamming
      if (connectionAttempts === 1) {
        console.log(`[Flow] Attempting to connect to WebSocket at ${url} (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})`);
      }

      ws = new WebSocketImpl(url);

      ws.on('open', () => {
        connecting = false;
        // Reset connection attempts on successful connection
        connectionAttempts = 0;
        console.log(`[Flow] WebSocket connected to ${url}`);

        // flush buffered events
        if (queue.length) {
          const queueLength = queue.length;
          if (queueLength > 0) {
            console.log(`[Flow] Sending ${queueLength} queued events`);
          }

          for (const msg of queue) {
            ws.send(msg);
          }
          queue = [];
        }
      });

      ws.on('close', () => {
        ws = null;
        connecting = false;

        if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
          console.log(`[Flow] WebSocket disconnected, will retry in ${retryMs}ms (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})`);
          setTimeout(connect, retryMs);
        } else {
          console.log(`[Flow] WebSocket connection failed after ${MAX_CONNECTION_ATTEMPTS} attempts. Falling back to console logging only.`);
        }
      });

      ws.on('error', (err: Error) => {
        // Only log the first error to avoid filling the console
        if (connectionAttempts === 1) {
          console.error(`[Flow] WebSocket connection error: ${err.message}`);
        }
        // errors are typically followed by close events, so we don't need to do anything here
      });
    } catch (err) {
      console.error(`[Flow] Error creating WebSocket: ${err.message}`);
      connecting = false;

      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        setTimeout(connect, retryMs);
      } else {
        console.log(`[Flow] WebSocket connection failed after ${MAX_CONNECTION_ATTEMPTS} attempts. Falling back to console logging only.`);
      }
    }
  }

  // We'll connect when WebSocketImpl is available

  // Return a FlowLogger function that works even before WebSocket is fully initialized
  return (evt) => {
    const payload = JSON.stringify(evt);

    // Always log to console if mirror is enabled or WebSocket has permanently failed
    if (mirror || (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) || wsImportFailed) {
      // For snapshots, only log a simple message instead of the full payload to avoid console spam
      if (evt.t === 'snapshot') {
        console.log(`[Flow] Snapshot event with ${Object.keys(evt.stages).length} stages at ${new Date(evt.ts).toISOString()}`);
      } else {
        console.log(`[Flow] ${evt.t}`);
      }
    }

    // If we've given up on WebSocket connections, don't try to send or queue
    if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS || wsImportFailed) {
      return;
    }

    // If WebSocket is available and connected, send immediately
    if (ws && WebSocketImpl && ws.readyState === WebSocketImpl.OPEN) {
      try {
        ws.send(payload);
      } catch (err) {
        // Just queue on error without logging to avoid spam
        queue.push(payload);
      }
    } else {
      // Queue for later, with size limiting to prevent memory issues
      queue.push(payload);

      // More aggressive queue management
      const queueLimit = evt.t === 'snapshot' ? 10 : 100; // Keep fewer snapshots
      while (queue.length > queueLimit) {
        queue.shift(); // simple back-pressure
      }

      // Try to connect if we have WebSocketImpl and not already connecting/maxed out
      if (WebSocketImpl && !connecting && connectionAttempts < MAX_CONNECTION_ATTEMPTS &&
          (!ws || (ws.readyState === WebSocketImpl.CLOSED))) {
        connect();
      }
    }
  };
}
