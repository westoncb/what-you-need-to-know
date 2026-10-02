/* ------------------------------------------------------------------
   Flow Observer  – snapshot-only, calls/errors counters
------------------------------------------------------------------- */
import type { ChatMsg } from "./llm";
import type { LLMError } from "./flow-utils";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
export interface CallDetails {
  attempts?: number;
  raw?: string;
  disposition?: "skipped" | "fallback" | "propagated";
  errorInfo?: Pick<LLMError, "kind" | "status" | "code" | "providerCode" | "errorType" | "retryable">;
  recoveryError?: string;
}

export interface CallInfo extends CallDetails {
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
  if (LOGGER && !fn) emitSnapshot(); // Flush completions before a CLI closes its logger.
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
    Object.entries(obj).flatMap(([key, value]) =>
      typeof value !== "function" ? [[key, value]] : key === "onFailure" ? [[key, "callback"]] : []),
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

export function setCallPrompt(callId: string, prompt: ChatMsg[]) {
  const stageId = CALL_TO_STAGE.get(callId);
  if (!stageId) return;
  const call = STAGES.get(stageId)?.callList.find(call => call.id === callId);
  if (call?.state === "run") call.prompt = prompt;
}

export function endCall(
  callId : string,
  ok     : boolean,
  output?: unknown,
  error ?: string,
  started?: number,
  details: CallDetails = {},
) {
  const stageId = CALL_TO_STAGE.get(callId);
  if (!stageId) return;
  const stage = STAGES.get(stageId)!;

  const c = stage.callList.find(x => x.id === callId);
  if (!c || c.state !== "run") return;
  {
    c.output  = output;
    c.error   = error;
    c.state   = ok ? "done" : "error";
    c.latency = Date.now() - (started ?? c.started);
    const { errorInfo, ...rest } = details;
    Object.assign(c, rest);
    if (errorInfo) {
      const { kind, status, code, providerCode, errorType, retryable } = errorInfo;
      c.errorInfo = { kind, status, code, providerCode, errorType, retryable };
    }
  }
  CALL_TO_STAGE.delete(callId);

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

  return async function* (src: AsyncIterable<I>, opts?: unknown) {
    if (perItem) {
      let idx = 0;
      for await (const item of src) {
        const cid = startCall(stageId, idx++, item);
        let output: O | undefined;
        try {
          for await (const value of inner((async function* () { yield item; })(), opts)) {
            output = value;
            yield value;
          }
        } catch (error) {
          endCall(cid, false, undefined, String(error instanceof Error ? error.message : error));
          throw error;
        } finally {
          // Complete even when a filter emits nothing or the consumer stops early.
          endCall(cid, true, output);
        }
      }
    } else {
      const cid = startCall(stageId, 0, "[batch]");
      const outputs: O[] = [];
      try {
        for await (const value of inner(src, opts)) {
          outputs.push(value);
          yield value;
        }
      } catch (error) {
        endCall(cid, false, undefined, String(error instanceof Error ? error.message : error));
        throw error;
      } finally {
        endCall(cid, true, outputs);
      }
    }
  };
}
