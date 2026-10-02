import { transform, InvalidResponseError, LLMError, type ChatMsg, type TransformOpts } from "./llm";
import { Semaphore } from "./flow-utils";
import {
  instrumentStage, setLogger, type FlowLogger,
  newStageId, registerStage, stageMeta, startCall, setCallPrompt, endCall,
} from "./flow-observer";

export { setLogger, type FlowLogger, InvalidResponseError, LLMError };

/** An explicit omission, distinct from a successful undefined output. */
export const SKIP = Symbol("Flow.SKIP");
type Skip = typeof SKIP;

export type FailurePolicy<Out, Input> = "throw" | "skip" |
  ((error: LLMError, input: Input) => Out | Skip | Promise<Out | Skip>);
export type SelectionFailurePolicy<A> = "throw" |
  ((error: LLMError, pair: { a: A; b: A }) => A | Promise<A>);
export type LLMStageOpts<Out, Input, RecoveryInput = Input> =
  Omit<TransformOpts<Out, Input>, "prompt"> & {
    /** Runs after retries are exhausted. Defaults to "throw". Programming errors bypass recovery. */
    onFailure?: FailurePolicy<Out, RecoveryInput>;
  };

export type Stage<I, O> = (src: AsyncIterable<I>, opts?: StageOpts) => AsyncIterable<O>;
export interface StageOpts {
  /** Notification only: returning from this callback does not recover a failure. */
  onError?: (err: Error, ctx: unknown) => void;
}
function defaultOnError(err: Error, _ctx: unknown) { console.warn("[Flow]", err); }
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

function chain<A, B, C>(s1: Stage<A, B>, s2: Stage<B, C>): Stage<A, C> {
  return async function* (src, opts) { yield* s2(s1(src, opts), opts); };
}

/* CPU operations propagate callback errors; they are not failed LLM responses. */
export function mapStage<A, B>(
  fn: (a: A) => B | Promise<B>,
  concurrency = Infinity,
): Stage<A, B> {

  const pool = isFinite(concurrency) ? new Semaphore(concurrency) : null;

  async function* impl(src, { onError = defaultOnError } = {}) {
    for await (const item of src) {
      if (pool) await pool.acquire();
      try {
        yield await fn(item);
      } catch (e) {
        onError(e as Error, { stage: "map" });
        throw e;
      } finally {
        pool?.release();
      }
    }
  }

  return instrumentStage(
    "map", "cpu", { concurrency }, impl, /* perItem */ true,
  );
}

export function filterStage<A>(
  pred: (a: A) => boolean | Promise<boolean>,
  concurrency = Infinity,
): Stage<A, A> {

  const pool = isFinite(concurrency) ? new Semaphore(concurrency) : null;

  async function* impl(src, { onError = defaultOnError } = {}) {
    for await (const item of src) {
      if (pool) await pool.acquire();
      let keep = false;
      try {
        keep = await pred(item);
      } catch (e) {
        onError(e as Error, { stage: "filter" });
        throw e;
      } finally {
        pool?.release();
      }
      if (keep) yield item;
    }
  }

  return instrumentStage(
    "filter", "cpu", { concurrency }, impl, true,
  );
}

function foldStage<A, B>(
  seed: B,
  foldFn: (acc: B, a: A) => B | Promise<B>,
): Stage<A, B> {
  async function* impl(src, { onError = defaultOnError } = {}) {
    let acc = seed;
    for await (const item of src) {
      try { acc = await foldFn(acc, item); }
      catch (e) { onError(e as Error, { stage: "fold" }); throw e; }
    }
    yield acc;                       // emit once
  }
  return instrumentStage("fold", "cpu", {}, impl, false);
}

/* One completion path for every LLM operator, including reduction. */
async function callLLM<B, A, Pay = A, RecoveryInput = A>({
  stageId, idx, input, opts, onFailure = "throw", recoveryInput,
  onError = defaultOnError, validate, allowSkip = true,
}: {
  stageId: string;
  idx: number;
  input: A;
  opts: TransformOpts<B, A, Pay>;
  onFailure?: FailurePolicy<B, RecoveryInput>;
  recoveryInput?: RecoveryInput;
  onError?: StageOpts["onError"];
  validate?: (output: B) => void;
  allowSkip?: boolean;
}): Promise<B | Skip> {
  const started = Date.now();
  const cid = startCall(stageId, idx, input);
  let failure: LLMError | undefined;
  let attempts: number | undefined;
  let raw: string | undefined;
  try {
    const result = await transform(input, {
      ...opts,
      prompt: payload => {
        const messages = opts.prompt(payload);
        setCallPrompt(cid, messages);
        return messages;
      },
      post: (text, src, payload) => {
        const output = opts.post ? opts.post(text, src, payload) : text as B;
        validate?.(output);
        return output;
      },
    });
    attempts = result.attempts;
    raw = result.raw;
    if (result.ok === true) {
      endCall(cid, true, result.content, undefined, started, { attempts, raw });
      return result.content;
    }

    failure = result.error;
    onError(failure, { stageId, idx, input });
    if (onFailure === "throw") throw failure;
    const output = onFailure === "skip" ? SKIP :
      await onFailure(failure, recoveryInput === undefined ? input as unknown as RecoveryInput : recoveryInput);
    if (output === SKIP && !allowSkip) throw new TypeError("Selection recovery must return one of the two candidates; it cannot skip.");
    if (output !== SKIP) validate?.(output);
    endCall(cid, false, output === SKIP ? undefined : output, failure.message, started, {
      attempts, raw, disposition: output === SKIP ? "skipped" : "fallback",
      errorInfo: failure,
    });
    return output;
  } catch (error) {
    const thrown = asError(error);
    endCall(cid, false, undefined, failure?.message ?? thrown.message, started, {
      attempts, raw, disposition: "propagated", errorInfo: failure,
      recoveryError: failure && error !== failure ? thrown.message : undefined,
    });
    if (!failure) onError(thrown, { stageId, idx, input });
    throw error;
  }
}

function checkConcurrency(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Concurrency must be a positive integer.");
}

/** Bounded, ordered work. Handle rejections immediately, including on early consumer exit. */
async function* concurrentMap<A, B>(
  src: AsyncIterable<A>, worker: (item: A, idx: number) => Promise<B>, concurrency: number,
): AsyncGenerator<B> {
  type Settled = { ok: true; value: B } | { ok: false; error: unknown };
  const pending: Promise<Settled>[] = [];
  const iterator = src[Symbol.asyncIterator]();
  let stopped = false;
  let idx = 0;
  const unwrap = (result: Settled): B => {
    if (result.ok === false) throw result.error;
    return result.value;
  };
  try {
    while (!stopped) {
      const next = await iterator.next();
      if (next.done || stopped) break;
      const index = idx++;
      pending.push(Promise.resolve().then(() => worker(next.value, index)).then(
        value => ({ ok: true as const, value }),
        error => { stopped = true; return { ok: false as const, error }; },
      ));
      if (pending.length >= concurrency) yield unwrap(await pending.shift()!);
    }
    while (pending.length) yield unwrap(await pending.shift()!);
  } finally {
    stopped = true;
    try { await iterator.return?.(); }
    finally { await Promise.all(pending); }
  }
}

function registerLLM(name: string, opts: unknown, extra: Record<string, unknown> = {}) {
  const id = newStageId();
  registerStage(id, name, "llm", stageMeta(opts, extra));
  return id;
}

function llmMapStage<A, B>(
  prompt: (a: A) => ChatMsg[], opts: LLMStageOpts<B, A>, concurrency: number,
): Stage<A, B> {
  checkConcurrency(concurrency);
  const stageId = registerLLM("llmMap", opts, { concurrency });
  return async function* (src, { onError } = {}) {
    const outputs = concurrentMap(src, (input, idx) => callLLM({
      stageId, idx, input, opts: { ...opts, prompt }, onFailure: opts.onFailure, onError,
    }), concurrency);
    for await (const output of outputs) if (output !== SKIP) yield output;
  };
}

function llmFilterStage<A>(
  prompt: (a: A) => ChatMsg[], opts: LLMStageOpts<boolean, A>, concurrency: number,
): Stage<A, A> {
  checkConcurrency(concurrency);
  const stageId = registerLLM("llmFilter", opts, { concurrency });
  return async function* (src, { onError } = {}) {
    const outputs = concurrentMap(src, async (input, idx) => {
      const keep = await callLLM({
        stageId, idx, input, opts: { ...opts, prompt }, onFailure: opts.onFailure, onError,
        validate: output => {
          if (typeof output !== "boolean") throw new InvalidResponseError("llmFilter post() must return a boolean.");
        },
      });
      return keep !== SKIP && keep ? input : SKIP;
    }, concurrency);
    for await (const output of outputs) if (output !== SKIP) yield output;
  };
}

type SelectOpts<A> = Omit<TransformOpts<A, { a: A; b: A }>, "prompt"> & {
  onFailure?: SelectionFailurePolicy<A>;
};

function llmSelectStage<A>(
  k: number, prompt: (a: A, b: A) => ChatMsg[], opts: SelectOpts<A>, concurrency: number,
): Stage<A, A> {
  checkConcurrency(concurrency);
  if (!Number.isInteger(k) || k < 1) throw new RangeError("Selection size must be a positive integer.");
  const stageId = registerLLM("llmSelect", opts, { k, concurrency });
  return async function* (src, { onError } = {}) {
    const buf: A[] = [];
    for await (const item of src) buf.push(item);
    let idx = 0;
    while (buf.length > k) {
      const count = Math.min(concurrency, buf.length - k, Math.floor(buf.length / 2));
      const pairs = Array.from({ length: count }, () => ({ a: buf.shift()!, b: buf.shift()! }));
      const winners = concurrentMap((async function* () { yield* pairs; })(), async input => {
        const winner = await callLLM({
          stageId, idx: idx++, input, opts: { ...opts, prompt: pair => prompt(pair.a, pair.b) },
          onFailure: opts.onFailure, onError, allowSkip: false,
          validate: output => {
            if (output !== input.a && output !== input.b) throw new InvalidResponseError("llmSelect post() or recovery must return one of its candidates.");
          },
        });
        return winner as A; // SKIP is rejected at this operation's boundary.
      }, concurrency);
      for await (const winner of winners) buf.push(winner);
    }
    for (const item of buf) yield item;
  };
}

export class Flow<A> {
  private constructor(private readonly stage: Stage<any, A>, private readonly opts: StageOpts = {}) {}

  static from<A>(iter: Iterable<A> | AsyncIterable<A>, opts: StageOpts = {}): Flow<A> {
    async function* src() { for await (const item of iter) yield item; }
    return new Flow(src, opts);
  }

  map<B>(fn: (a: A) => B | Promise<B>, c = Infinity): Flow<B> {
    return new Flow(chain(this.stage, mapStage(fn, c)), this.opts);
  }
  filter(pred: (a: A) => boolean | Promise<boolean>, c = Infinity): Flow<A> {
    return new Flow(chain(this.stage, filterStage(pred, c)), this.opts);
  }
  fold<B>(seed: B, fn: (acc: B, a: A) => B | Promise<B>): Flow<B> {
    return new Flow(chain(this.stage, foldStage(seed, fn)), this.opts);
  }

  llmMap<B>(prompt: (a: A) => ChatMsg[], opts: LLMStageOpts<B, A>, c = 8): Flow<B> {
    return new Flow(chain(this.stage, llmMapStage(prompt, opts, c)), this.opts);
  }
  llmFilter(prompt: (a: A) => ChatMsg[], opts: LLMStageOpts<boolean, A>, c = 8): Flow<A> {
    return new Flow(chain(this.stage, llmFilterStage(prompt, opts, c)), this.opts);
  }
  llmSelect(k: number, prompt: (a: A, b: A) => ChatMsg[], opts: SelectOpts<A>, c = 4): Flow<A> {
    return new Flow(chain(this.stage, llmSelectStage(k, prompt, opts, c)), this.opts);
  }

  /** SKIP keeps the accumulator. Reducers/post callbacks should not mutate it before succeeding. */
  async llmReduce<B>(
    prompt: (acc: B, item: A) => ChatMsg[], seed: B,
    opts: LLMStageOpts<B, A, { acc: B; item: A }>,
  ): Promise<B> {
    let acc = seed;
    let idx = 0;
    const stageId = registerLLM("llmReduce", opts);
    for await (const item of this.iter()) {
      const output = await callLLM({
        stageId, idx: idx++, input: item, opts: { ...opts, prompt: () => prompt(acc, item) },
        recoveryInput: { acc, item }, onFailure: opts.onFailure, onError: this.opts.onError,
      });
      if (output !== SKIP) acc = output;
    }
    return acc;
  }

  private iter(): AsyncIterable<A> { return this.stage(asyncEmpty(), this.opts); }

  async reduce<B>(fold: (acc: B, item: A) => B | Promise<B>, seed: B): Promise<B> {
    let acc = seed;
    for await (const item of this.iter()) acc = await fold(acc, item);
    return acc;
  }

  async run(input?: Iterable<A> | AsyncIterable<A>): Promise<A[]> {
    const src = input ? (async function* () { for await (const item of input) yield item; })() : asyncEmpty<A>();
    const out: A[] = [];
    for await (const item of this.stage(src, this.opts)) out.push(item);
    return out;
  }
}

async function* asyncEmpty<T>(): AsyncGenerator<T> { /* no-op */ }
