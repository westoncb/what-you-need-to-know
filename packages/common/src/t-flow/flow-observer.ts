import type { ChatMsg } from "./openrouter";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
export interface CallInfo {
  id     : string;
  idx    : number;
  input  : unknown;
  prompt?: ChatMsg[];
  output?: unknown;
  error ?: string;
  started: number;
  latency?: number;
  state  : "run" | "done" | "error";
}
export interface StageInfo {
  id        : string;
  name      : string;
  kind      : "cpu" | "llm";
  cfg       : Record<string, unknown>;
  totals    : { in: number; out: number; err: number };
  openCalls : number;
  lastCall? : number;
  calls     : CallInfo[];
}
export interface SnapshotEvent {
  t : "snapshot";
  ts: number;
  stages: Record<string, StageInfo>;
}
export type FlowEvent = SnapshotEvent;
export type FlowLogger = (e: SnapshotEvent) => void;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const STAGES = new Map<string, StageInfo>();
const CALL_TO_STAGE = new Map<string, string>();
let stageCounter = 0;
let callCounter  = 0;

/* ------------------------------------------------------------------ */
/* Logger setup                                                       */
/* ------------------------------------------------------------------ */
let LOGGER: FlowLogger | null = null;
let snapTimer: NodeJS.Timeout | null = null;
let SNAP_MS = 100;       // default 10 Hz

export function setLogger(
  fn: FlowLogger | null,
  opts: { snapshotMs?: number } = {},
) {
  LOGGER  = fn;
  SNAP_MS = opts.snapshotMs ?? SNAP_MS;
  if (snapTimer) clearInterval(snapTimer), (snapTimer = null);
  if (fn) {
    snapTimer = setInterval(emitSnapshot, SNAP_MS);
    (snapTimer as any).unref?.();
  }
}

function emitSnapshot() {
  if (!LOGGER) return;
  // deep‑clone via JSON is fine at our scale
  const stagesObj: Record<string, StageInfo> = JSON.parse(
    JSON.stringify(Object.fromEntries(STAGES))
  );
  LOGGER({ t: "snapshot", ts: Date.now(), stages: stagesObj });
}

/* ------------------------------------------------------------------ */
/* Public helpers for stages                                          */
/* ------------------------------------------------------------------ */
export function newStageId() { return `S${stageCounter++}`; }

export function registerStage(
  id  : string,
  name: string,
  kind: "cpu" | "llm",
  cfg : Record<string, unknown> = {},
) {
  STAGES.set(id, {
    id, name, kind, cfg,
    totals: { in: 0, out: 0, err: 0 },
    openCalls: 0,
    calls: [],
  });
}

export function startCall(
  stageId: string,
  idx    : number,
  input  : unknown,
  prompt?: ChatMsg[],
): string {
  const cid = `C${callCounter++}`;
  const stage = STAGES.get(stageId);
  if (!stage) throw new Error(`Unknown stage ${stageId}`);

  stage.totals.in++;
  stage.openCalls++;
  stage.calls.push({
    id: cid, idx, input, prompt,
    started: Date.now(), state: "run",
  });
  CALL_TO_STAGE.set(cid, stageId);
  return cid;
}

export function endCall(
  callId : string,
  ok     : boolean,
  output?: unknown,
  error ?: string,
  started?: number,
) {
  const stageId = CALL_TO_STAGE.get(callId);
  if (!stageId) return;
  const stage = STAGES.get(stageId)!;
  const call  = stage.calls.find(c => c.id === callId);
  if (!call) return;

  call.output  = output;
  call.error   = error;
  call.latency = started ? Date.now() - started : undefined;
  call.state   = ok ? "done" : "error";

  if (ok) stage.totals.out++; else stage.totals.err++;
  stage.openCalls--;
  stage.lastCall = Date.now();
}

/* ------------------------------------------------------------------ */
/* Stage decorator (unchanged except it no longer logs per‑event)     */
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
