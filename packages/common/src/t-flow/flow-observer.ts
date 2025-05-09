/* ------------------------------------------------------------------
   Flow Observer – v2.1
   ------------------------------------------------------------------
   • Emits typed events for UI streaming via WebSocket or any transport.
   • Maintains a ring‑buffer of the most recent `ringSize` *completed* calls
     per stage (never drops in‑flight calls).
   • Emits a terminal "flow_end" event so UIs can reset without heuristics.
--------------------------------------------------------------------*/
import type { ChatMsg } from "./openrouter";

/* ------------------------------------------------------------------ */
/* Event types                                                        */
/* ------------------------------------------------------------------ */
export type FlowEvent =
  | { t: "stage_create"; id: string; name: string; kind: "cpu" | "llm"; cfg: Record<string, unknown> }
  | { t: "call_start" ; id: string; stage: string; idx: number; input: unknown; prompt?: ChatMsg[]; ts: number }
  | { t: "call_end"   ; id: string; ok: boolean; output?: unknown; error?: string; latency: number; ts: number }
  | { t: "snapshot"   ; ts: number; stages: Record<string, StageSnapshot> }
  | { t: "flow_end"   ; ts: number };

export interface StageSnapshot {
  name      : string;
  kind      : "cpu" | "llm";
  cfg       : Record<string, unknown>;
  totals    : { in: number; out: number; err: number };
  openCalls : number;
  lastCall? : number;
}

export type FlowLogger = (e: FlowEvent) => void;

/* ------------------------------------------------------------------ */
/* Runtime state                                                      */
/* ------------------------------------------------------------------ */
export interface CallInfo {
  id     : string;
  stage  : string;
  idx    : number;
  input  : unknown;
  prompt?: ChatMsg[];
  output?: unknown;
  error ?: string;
  started: number;
  latency?: number;
  state  : "run" | "done" | "error";
}

export interface StageInfo extends StageSnapshot {
  id    : string;
  /** Map keyed by callId (insertion order preserved). */
  calls : Map<string, CallInfo>;
}

/* ------------------------------------------------------------------ */
/* Internal data structures                                           */
/* ------------------------------------------------------------------ */
const STAGES      = new Map<string, StageInfo>();
const CALL_TO_STG = new Map<string, string>();

let stageCounter = 0;
let callCounter  = 0;

/* ------------------------------------------------------------------ */
/* Logger configuration                                               */
/* ------------------------------------------------------------------ */
let LOGGER   : FlowLogger | null = null;
let snapTimer: NodeJS.Timeout | null = null;

let SNAP_MS = 0;         // snapshot cadence (ms)
let RING    = Infinity;  // max completed calls retained per stage

export function setLogger(
  fn: FlowLogger | null,
  opts: { snapshotMs?: number; ringSize?: number } = {},
) {
  LOGGER  = fn;
  SNAP_MS = opts.snapshotMs ?? SNAP_MS;
  RING    = opts.ringSize   ?? RING;

  if (snapTimer) clearInterval(snapTimer), (snapTimer = null);
  if (fn && SNAP_MS > 0) {
    snapTimer = setInterval(emitSnapshot, SNAP_MS);
    (snapTimer as any).unref?.(); // don’t keep Node alive
  }
}

function log(evt: FlowEvent) {
  try { LOGGER?.(evt); } catch (err) {
    console.error("[Flow] logger threw:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Snapshot helpers                                                   */
/* ------------------------------------------------------------------ */
function emitSnapshot() {
  const snap: Record<string, StageSnapshot> = {};
  STAGES.forEach((s, id) => {
    snap[id] = {
      name     : s.name,
      kind     : s.kind,
      cfg      : s.cfg,
      totals   : { ...s.totals },
      openCalls: s.openCalls,
      lastCall : s.lastCall,
    };
  });
  log({ t: "snapshot", ts: Date.now(), stages: snap });
}

/* ------------------------------------------------------------------ */
/* Public API – stage / call lifecycle                                */
/* ------------------------------------------------------------------ */
export function newStageId() { return `S${stageCounter++}`; }

export function registerStage(
  id : string,
  name: string,
  kind: "cpu" | "llm",
  cfg : Record<string, unknown>,
) {
  STAGES.set(id, {
    id,
    name,
    kind,
    cfg,
    totals   : { in: 0, out: 0, err: 0 },
    openCalls: 0,
    calls    : new Map(),
  });
  log({ t: "stage_create", id, name, kind, cfg });
}

export function startCall(
  stageId: string,
  idx    : number,
  input  : unknown,
  prompt?: ChatMsg[],
): string {
  const cid   = `C${callCounter++}`;
  const stage = STAGES.get(stageId);
  if (!stage) throw new Error(`Unknown stage ${stageId}`);

  stage.totals.in++;
  stage.openCalls++;

  stage.calls.set(cid, {
    id: cid, stage: stageId, idx, input, prompt,
    started: Date.now(), state: "run",
  });
  CALL_TO_STG.set(cid, stageId);

  log({ t: "call_start", id: cid, stage: stageId, idx, input, prompt, ts: Date.now() });
  return cid;
}

export function endCall(
  callId : string,
  ok     : boolean,
  output?: unknown,
  error ?: string,
  started?: number,
) {
  const stageId = CALL_TO_STG.get(callId);
  if (!stageId) return;
  const stage = STAGES.get(stageId)!;

  const call = stage.calls.get(callId);
  if (call) {
    call.output  = output;
    call.error   = error;
    call.latency = started ? Date.now() - started : undefined;
    call.state   = ok ? "done" : "error";
  }

  if (ok) stage.totals.out++; else stage.totals.err++;
  stage.openCalls--;
  stage.lastCall = Date.now();

  // after marking completed, evict if we exceed RING
  while (stage.calls.size > RING) {
    const oldest = stage.calls.keys().next().value as string;
    const info   = stage.calls.get(oldest);
    if (info && info.state === "run") break;  // never drop in‑flight calls
    stage.calls.delete(oldest);
  }

  log({ t: "call_end", id: callId, ok, output, error,
        latency: started ? Date.now() - started : 0, ts: Date.now() });
}

/** Emit once Flow.run() resolves. */
export function flowEnd() { log({ t: "flow_end", ts: Date.now() }); }

/* ------------------------------------------------------------------ */
/* Stage decorator                                                    */
/* ------------------------------------------------------------------ */
export type Stage<I, O> = (src: AsyncIterable<I>, opts?: unknown) => AsyncIterable<O>;

export function instrumentStage<I, O>(
  name   : string,
  kind   : "cpu" | "llm",
  cfg    : Record<string, unknown>,
  inner  : Stage<I, O>,
  perItem = true,
): Stage<I, O> {
  const id = newStageId();
  registerStage(id, name, kind, cfg);

  return async function* (src: AsyncIterable<I>, opts?: unknown) {
    if (perItem) {
      let idx = 0;
      for await (const item of src) {
        const started = Date.now();
        const cid     = startCall(id, idx++, item);
        try {
          for await (const o of inner((async function*(){ yield item; })(), opts))
            yield o, endCall(cid, true, o, undefined, started);
        } catch (err) {
          endCall(cid, false, undefined, String((err as Error).message), started);
          throw err;
        }
      }
    } else {
      const started = Date.now();
      const cid     = startCall(id, 0, "[batch]");
      try {
        for await (const o of inner(src, opts)) yield o;
        endCall(cid, true, "[batch-end]", undefined, started);
      } catch (err) {
        endCall(cid, false, undefined, String((err as Error).message), started);
        throw err;
      }
    }
  };
}
