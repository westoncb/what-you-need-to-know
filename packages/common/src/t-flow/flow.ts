import { call, ChatMsg, CallOpts } from "./openrouter";
import { Semaphore }               from "./flow-utils";

import {
  instrumentStage, setLogger, type FlowLogger,
  newStageId, registerStage, startCall, endCall
} from "./flow-observer";


/* ------------------------------------------------------------------ */
/* Public re-exports                                                  */
/* ------------------------------------------------------------------ */
export { setLogger, FlowLogger };

/* ------------------------------------------------------------------ */
/* Internal helpers                                                   */
/* ------------------------------------------------------------------ */
export type Stage<I, O> =
  (src: AsyncIterable<I>, opts?: StageOpts) => AsyncIterable<O>;

export interface StageOpts {
  onError?: (err: Error, ctx: unknown) => void;
}

function defaultOnError(err: Error, ctx: unknown) {
  console.warn("[Flow]", err.message, ctx);
}

function chain<A, B, C>(
  s1: Stage<A, B>, s2: Stage<B, C>,
): Stage<A, C> {
  return async function* (src, opts) {
    yield* s2(s1(src, opts), opts);
  };
}

/* ------------------------------------------------------------------ */
/* CPU stages                                                         */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* LLM stages                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* LLM map – one output per item                                      */
/* ------------------------------------------------------------------ */
function llmMapStage<A, B>(
  model: string,
  promptFn: (a: A) => ChatMsg[],
  opts: CallOpts<B>,
  concurrency = 8,
): Stage<A, B> {

  const pool    = new Semaphore(concurrency);
  const stageId = newStageId();

  registerStage(stageId, "llmMap", "llm",
                { model, ...opts, concurrency });

  return async function* (src, { onError = defaultOnError } = {}) {
    let idx = 0;
    for await (const item of src) {
      const prompt  = promptFn(item);
      const started = Date.now();
      const cid     = startCall(stageId, idx++, item, prompt);

      await pool.acquire();
      try {
        const res = await call<B>(model, prompt, opts);
        if (!res.ok) throw res.error;
        endCall(cid, true, res.content, undefined, started);
        yield res.content as B;
      } catch (e) {
        endCall(cid, false, undefined, (e as Error).message, started);
        onError(e as Error, { stage: "llmMap" });
      } finally {
        pool.release();
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* LLM filter – yields input only if judge keeps it                   */
/* ------------------------------------------------------------------ */
function llmFilterStage<A>(
  model: string,
  judgePrompt: (a: A) => ChatMsg[],
  opts: CallOpts<boolean>,
  concurrency = 8,
): Stage<A, A> {

  const pool    = new Semaphore(concurrency);
  const stageId = newStageId();

  registerStage(stageId, "llmFilter", "llm",
                { model, ...opts, concurrency });

  return async function* (src, { onError = defaultOnError } = {}) {
    let idx = 0;
    for await (const item of src) {
      const prompt  = judgePrompt(item);
      const started = Date.now();
      const cid     = startCall(stageId, idx++, item, prompt);

      await pool.acquire();
      try {
        const res  = await call<boolean>(model, prompt, opts);
        const keep = res.ok && Boolean(res.content);
        endCall(cid, true, keep, undefined, started);
        if (keep) yield item;
      } catch (e) {
        endCall(cid, false, undefined, (e as Error).message, started);
        onError(e as Error, { stage: "llmFilter" });
      } finally {
        pool.release();
      }
    }
  };
}

function llmSelectStage<A>(
  k: number,
  model: string,
  duelPrompt: (a: A, b: A) => ChatMsg[],
  opts: CallOpts<A>,
  concurrency = 4,
): Stage<A, A> {

  const pool     = new Semaphore(concurrency);
  const stageId  = newStageId();

  registerStage(stageId, "llmSelect", "llm",
                { k, model, ...opts, concurrency });

  return async function* (src, { onError = defaultOnError } = {}) {
    const buf: A[] = [];
    for await (const it of src) buf.push(it);

    if (buf.length <= k) { for (const it of buf) yield it; return; }

    let duelIdx = 0;

    while (buf.length > k) {
      const pairs = Math.min(concurrency, buf.length - k);
      const tasks: Promise<A>[] = [];

      for (let i = 0; i < pairs && buf.length > 1; i++) {
        const a = buf.shift()!, b = buf.shift() ?? a;

        const prompt  = duelPrompt(a, b);
        const started = Date.now();
        const cid     = startCall(stageId, duelIdx++, { a, b }, prompt);

        await pool.acquire();
        tasks.push((async () => {
          try {
            const res = await call<A>(model, prompt, opts);
            const winner = res.ok ? (res.content as A) : a;
            endCall(cid, true, winner, undefined, started);
            return winner;
          } catch (e) {
            endCall(cid, false, undefined, (e as Error).message, started);
            onError(e as Error, { stage: "llmSelect" });
            return a;
          } finally {
            pool.release();
          }
        })());
      }
      buf.push(...await Promise.all(tasks));
    }

    for (const it of buf) yield it;
  };
}


/* ------------------------------------------------------------------ */
/* Flow class (API unchanged)                                         */
/* ------------------------------------------------------------------ */
export class Flow<A> {
  private constructor(
    private readonly stage: Stage<any, A>,
    private readonly opts: StageOpts = {},
  ) {}

  static from<A>(iter: Iterable<A> | AsyncIterable<A>): Flow<A> {
    async function* src() { for await (const i of iter) yield i; }
    return new Flow(src);
  }

  withOptions(opts: StageOpts): Flow<A> {
    return new Flow(this.stage, { ...this.opts, ...opts });
  }

  /* CPU ops */
  map<B>(fn: (a: A) => B | Promise<B>, c = Infinity): Flow<B> {
    return new Flow(chain(this.stage, mapStage(fn, c)), this.opts);
  }
  filter(pred: (a: A) => boolean | Promise<boolean>, c = Infinity): Flow<A> {
    return new Flow(chain(this.stage, filterStage(pred, c)), this.opts);
  }

  /* LLM ops */
  llmMap<B>(
    model: string,
    promptFn: (a: A) => ChatMsg[],
    opts: CallOpts<B> = {},
    c = 8,
  ): Flow<B> {
    return new Flow(
      chain(this.stage, llmMapStage(model, promptFn, opts, c)),
      this.opts,
    );
  }
  llmFilter(
    model: string,
    judgePrompt: (a: A) => ChatMsg[],
    opts: CallOpts<boolean> = {},
    c = 8,
  ): Flow<A> {
    return new Flow(
      chain(this.stage, llmFilterStage(model, judgePrompt, opts, c)),
      this.opts,
    );
  }
  llmSelect(
    k: number,
    model: string,
    duelPrompt: (a: A, b: A) => ChatMsg[],
    opts: CallOpts<A> = {},
    c = 4,
  ): Flow<A> {
    return new Flow(
      chain(this.stage, llmSelectStage(k, model, duelPrompt, opts, c)),
      this.opts,
    );
  }

  /* terminals */
  async reduce<B>(
    fold: (acc: B, a: A) => B | Promise<B>,
    seed: B,
  ): Promise<B> {
    let acc = seed;
    for await (const item of this.stage(asyncEmpty(), this.opts))
      acc = await fold(acc, item);
    return acc;
  }

  async llmReduce<B>(
    model: string,
    foldPrompt: (acc: B, a: A) => ChatMsg[],
    seed: B,
    opts: CallOpts<B> = {},
  ): Promise<B> {
    let acc = seed;
    for await (const item of this.stage(asyncEmpty(), this.opts)) {
      const res = await call<B>(model, foldPrompt(acc, item), opts);
      if (res.ok) acc = res.content as B;
      else this.opts.onError?.(res.error!, { stage: "llmReduce" });
    }
    return acc;
  }

  /* run */
  async run(input?: Iterable<A> | AsyncIterable<A>): Promise<A[]> {
    const src = input
      ? (async function* () { for await (const i of input) yield i; })()
      : asyncEmpty<A>();

    const out: A[] = [];
    for await (const item of this.stage(src, this.opts)) out.push(item);
    return out;
  }
}

async function* asyncEmpty<T>() { /* no-op */ }
