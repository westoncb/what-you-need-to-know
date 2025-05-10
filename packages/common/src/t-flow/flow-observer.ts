/* ------------------------------------------------------------------
   Flow Observer  – snapshot-only, calls/errors counters
------------------------------------------------------------------- */
import type { ChatMsg } from "./llm";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
export interface CallInfo {
  id      : string;
  idx     : number;
  input   : unknown;
  prompt ?: ChatMsg[];
  output ?: unknown;
  error  ?: string;
  started : number;
  latency?: number;
  state   : "run" | "done" | "error";
}

export interface StageInfo {
  id        : string;
  name      : string;
  kind      : "cpu" | "llm";
  cfg       : Record<string, unknown>;
  calls     : number;        // total calls started
  errors    : number;        // calls ended in error
  openCalls : number;        // currently running
  lastCall ?: number;        // ms epoch
  callList  : CallInfo[];
}

/* snapshot is the ONLY event the outside world sees */
export type FlowEvent =
  { t: "snapshot"; ts: number; stages: Record<string, StageInfo> };

export type FlowLogger = (e: FlowEvent) => void;

/* ------------------------------------------------------------------ */
/* Internal state                                                     */
/* ------------------------------------------------------------------ */
const STAGES        = new Map<string, StageInfo>();
const CALL_TO_STAGE = new Map<string, string>();

let stageCounter = 0;
let callCounter  = 0;

/* ------------------------------------------------------------------ */
/* Logger setup                                                       */
/* ------------------------------------------------------------------ */
let LOGGER: FlowLogger | null = null;
let snapTimer: NodeJS.Timeout | null = null;
let SNAP_MS = 100;                      // default 10 Hz

export function setLogger(
  fn: FlowLogger | null,
  { snapshotMs = 100 }: { snapshotMs?: number } = {},
) {
  LOGGER  = fn;
  SNAP_MS = snapshotMs;

  if (snapTimer) clearInterval(snapTimer), (snapTimer = null);
  if (fn) {
    snapTimer = setInterval(emitSnapshot, SNAP_MS);
    (snapTimer as any).unref?.();       // don’t block process exit (Node)
  }
}

function emitSnapshot() {
  if (!LOGGER) return;
  LOGGER({
    t: "snapshot",
    ts: Date.now(),
    stages: Object.fromEntries(STAGES),
  });
}

/* ------------------------------------------------------------------ */
/* Stage & call bookkeeping                                           */
/* ------------------------------------------------------------------ */
export function newStageId() {
  return `S${stageCounter++}`;
}

export function registerStage(
  id  : string,
  name: string,
  kind: "cpu" | "llm",
  cfg : Record<string, unknown> = {},
) {
  STAGES.set(id, {
    id, name, kind, cfg,
    calls: 0, errors: 0, openCalls: 0, callList: [],
  });
}

export function stageMeta(
  opts : unknown,                              // << accept anything
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const obj = opts as Record<string, unknown>; // 1-line cast
  const filtered = Object.fromEntries(
    Object.entries(obj).filter(([, v]) => typeof v !== "function"),
  );
  return { ...filtered, ...extra };
}



/* called by wrappers / instrumentStage */
export function startCall(
  stageId: string,
  idx    : number,
  input  : unknown,
  prompt?: ChatMsg[],
): string {
  const cid   = `C${callCounter++}`;
  const stage = STAGES.get(stageId);
  if (!stage) throw new Error(`Unknown stage ${stageId}`);

  stage.calls++;
  stage.openCalls++;
  stage.callList.push({
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

  const c = stage.callList.find(x => x.id === callId);
  if (c) {
    c.output  = output;
    c.error   = error;
    c.state   = ok ? "done" : "error";
    c.latency = started ? Date.now() - started : undefined;
  }

  if (!ok) stage.errors++;
  stage.openCalls--;
  stage.lastCall = Date.now();
}

/* ------------------------------------------------------------------ */
/* Stage decorator – unchanged API                                    */
/* ------------------------------------------------------------------ */
export type Stage<I, O> =
  (src: AsyncIterable<I>, opts?: unknown) => AsyncIterable<O>;

/**
 * Wrap a stage generator to auto-log calls.
 *
 * @param name      label ("map", "llmMap", …)
 * @param kind      'cpu' | 'llm'
 * @param cfg       static config (model, temp, …)
 * @param inner     original stage implementation
 * @param perItem   true → one call per item; false → one for whole stream
 */
export function instrumentStage<I, O>(
  name : string,
  kind : "cpu" | "llm",
  cfg  : Record<string, unknown>,
  inner: Stage<I, O>,
  perItem = true,
): Stage<I, O> {
  const stageId = newStageId();
  registerStage(stageId, name, kind, cfg);

  /* return wrapper generator */
  return async function* (src: AsyncIterable<I>, opts?: unknown) {
    if (perItem) {
      let idx = 0;
      for await (const item of src) {
        const started = Date.now();
        const cid     = startCall(stageId, idx++, item);

        try {
          for await (const o of inner(
            (async function* () { yield item; })(), opts))
          {
            yield o;
            endCall(cid, true, o, undefined, started);
          }
        } catch (err) {
          endCall(
            cid, false, undefined,
            (err as Error).message, started,
          );
          throw err;
        }
      }
    } else {
      /* batch mode: one call for entire src */
      const started = Date.now();
      const cid     = startCall(stageId, 0, "[batch]");
      const batchItems = [];
      try {
        for await (const o of inner(src, opts)){
          batchItems.push(o);
          yield o
        };
        endCall(cid, true, "[batch-end]" + batchItems.join("\n"), undefined, started);
      } catch (err) {
        endCall(
          cid, false, undefined,
          (err as Error).message, started,
        );
        throw err;
      }
    }
  };
}
