import { call, ChatMsg, CallOpts } from "./openrouter";
import { Semaphore } from "./flow-utils";

import {
  instrument, // stage decorator
  instrumentBatch,
  setLogger, // re-export so callers do Flow.setLogger
  type FlowLogger,
} from "./flow-observer";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                    */
/* ------------------------------------------------------------------ */
export { setLogger, FlowLogger }; // bubble up re-export

export type Stage<I, O> = (
  src: AsyncIterable<I>,
  opts?: StageOpts,
) => AsyncIterable<O>;

export interface StageOpts {
  onError?: (err: Error, ctx: unknown) => void;
}

function defaultOnError(err: Error, ctx: unknown) {
  console.warn("[Flow]", err.message, ctx);
}

function chain<A, B, C>(s1: Stage<A, B>, s2: Stage<B, C>): Stage<A, C> {
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
    let idx = 0;
    for await (const item of src) {
      const curIdx = idx++;
      if (pool) await pool.acquire();
      const p = (async () => {
        try {
          return await fn(item);
        } catch (e) {
          onError(e as Error, { stage: "map", index: curIdx });
        } finally {
          pool?.release();
        }
      })();
      const out = await p;
      if (out !== undefined) yield out;
    }
  }
  return instrument("map", "cpu", { concurrency }, impl);
}

export function filterStage<A>(
  pred: (a: A) => boolean | Promise<boolean>,
  concurrency = Infinity,
): Stage<A, A> {
  const pool = isFinite(concurrency) ? new Semaphore(concurrency) : null;

  async function* impl(src, { onError = defaultOnError } = {}) {
    let idx = 0;
    for await (const item of src) {
      const curIdx = idx++;
      if (pool) await pool.acquire();
      const keepP = (async () => {
        try {
          return await pred(item);
        } catch (e) {
          onError(e as Error, { stage: "filter", index: curIdx });
        } finally {
          pool?.release();
        }
      })();
      if (await keepP) yield item;
    }
  }
  return instrument("filter", "cpu", { concurrency }, impl);
}

/* ------------------------------------------------------------------ */
/* LLM stages                                                         */
/* ------------------------------------------------------------------ */
function llmMapStage<A, B>(
  model: string,
  promptFn: (a: A) => ChatMsg[],
  opts: CallOpts<B>,
  concurrency = 8,
): Stage<A, B> {
  const pool = new Semaphore(concurrency);

  async function* impl(src, { onError = defaultOnError } = {}) {
    let idx = 0;
    for await (const item of src) {
      const curIdx = idx++;
      await pool.acquire();
      const p = (async () => {
        try {
          const res = await call<B>(model, promptFn(item), opts);
          if (!res.ok) throw res.error;
          return res.content as B;
        } catch (e) {
          onError(e as Error, { stage: "llmMap", index: curIdx });
        } finally {
          pool.release();
        }
      })();
      const out = await p;
      if (out !== undefined) yield out;
    }
  }
  return instrument("llmMap", "llm", { model, ...opts, concurrency }, impl);
}

function llmFilterStage<A>(
  model: string,
  judgePrompt: (a: A) => ChatMsg[],
  opts: CallOpts<boolean>,
  concurrency = 8,
): Stage<A, A> {
  const pool = new Semaphore(concurrency);

  async function* impl(src, { onError = defaultOnError } = {}) {
    let idx = 0;
    for await (const item of src) {
      const curIdx = idx++;
      await pool.acquire();
      const keepP = (async () => {
        try {
          const res = await call<boolean>(model, judgePrompt(item), opts);
          if (!res.ok) throw res.error;
          return Boolean(res.content);
        } catch (e) {
          onError(e as Error, { stage: "llmFilter", index: curIdx });
          return false;
        } finally {
          pool.release();
        }
      })();
      if (await keepP) yield item;
    }
  }
  return instrument("llmFilter", "llm", { model, ...opts, concurrency }, impl);
}

function llmSelectStage<A>(
  k: number,
  model: string,
  duelPrompt: (a: A, b: A) => ChatMsg[],
  opts: CallOpts<A>,
  concurrency = 4,
): Stage<A, A> {
  const pool = new Semaphore(concurrency);

  async function* impl(src, { onError = defaultOnError } = {}) {
    const buf: A[] = [];
    for await (const it of src) buf.push(it);

    if (buf.length <= k) {
      for (const it of buf) yield it;
      return;
    }

    while (buf.length > k) {
      const tasks: Promise<A>[] = [];
      const pairs = Math.min(concurrency, Math.floor((buf.length - k) / 1));

      for (let i = 0; i < pairs && buf.length > 1; i++) {
        const a = buf.shift()!,
          b = buf.shift() ?? a;
        await pool.acquire();
        tasks.push(
          (async () => {
            try {
              const res = await call<A>(model, duelPrompt(a, b), opts);
              return res.ok ? (res.content as A) : a;
            } catch (e) {
              onError(e as Error, { stage: "llmSelect" });
              return a;
            } finally {
              pool.release();
            }
          })(),
        );
      }
      buf.push(...(await Promise.all(tasks)));
    }
    for (const it of buf) yield it;
  }

  return instrumentBatch(
    "llmSelect",
    "llm",
    { k, model, ...opts, concurrency },
    impl,
  );
}

/* ------------------------------------------------------------------ */
/* Flow class (unchanged API)                                          */
/* ------------------------------------------------------------------ */
export class Flow<A> {
  private constructor(
    private readonly stage: Stage<any, A>,
    private readonly opts: StageOpts = {},
  ) {}

  static from<A>(iter: Iterable<A> | AsyncIterable<A>): Flow<A> {
    async function* src() {
      for await (const i of iter) yield i;
    }
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
  async reduce<B>(fold: (acc: B, a: A) => B | Promise<B>, seed: B): Promise<B> {
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

  async run(input?: Iterable<A> | AsyncIterable<A>): Promise<A[]> {
    const src = input
      ? (async function* () {
          for await (const i of input) yield i;
        })()
      : asyncEmpty<A>();
    const out: A[] = [];
    for await (const item of this.stage(src, this.opts)) out.push(item);
    return out;
  }
}

async function* asyncEmpty<T>() {
  /* yields nothing */
}
