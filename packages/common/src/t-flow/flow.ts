import { transform, ChatMsg, TransformOpts } from "./llm";
import { Semaphore }               from "./flow-utils";

import {
  instrumentStage, setLogger, type FlowLogger,
  newStageId, registerStage, stageMeta, startCall, endCall
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
  console.warn("[Flow]", err);
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

function foldStage<A, B>(
  seed: B,
  foldFn: (acc: B, a: A) => B | Promise<B>,
): Stage<A, B> {
  async function* impl(src, { onError = defaultOnError } = {}) {
    let acc = seed;
    for await (const item of src) {
      try { acc = await foldFn(acc, item); }
      catch (e) { onError(e as Error, { stage: "fold" }); }
    }
    yield acc;                       // emit once
  }
  return instrumentStage("fold", "cpu", {}, impl, false);
}

/* ------------------------------------------------------------------ */
/* LLM stages                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* LLM map – one output per item                                      */
/* ------------------------------------------------------------------ */
function llmMapStage<A, B, Pay = A>(
  opts: TransformOpts<B, A, Pay>,   // contains model, prompt, pre, post …
  concurrency = 8,
): Stage<A, B> {

  const pool    = new Semaphore(concurrency);
  const stageId = newStageId();
  const { pre, prompt } = opts;

  registerStage(
    stageId,
    "llmMap",
    "llm",
    stageMeta(opts, {concurrency})
  );

  return async function* (src, { onError = defaultOnError } = {}) {
    let idx = 0;

    for await (const item of src) {
      /* ---------- build prompt for logging ---------- */
      const payload  = pre ? pre(item) : (item as unknown as Pay);
      const messages = prompt(payload);

      const started  = Date.now();
      const cid      = startCall(stageId, idx++, item, messages);

      await pool.acquire();
      try {
        /* ---------- actual transform call ---------- */
        const res = await transform(item, opts);
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
function llmFilterStage<A, Pay = A>(
  judgePrompt: (p: Pay) => ChatMsg[],                 // still top-level
  baseOpts:   TransformOpts<boolean, A, Pay> & { model: string },
  concurrency = 8,
): Stage<A, A> {

  const pool    = new Semaphore(concurrency);
  const stageId = newStageId();

  registerStage(
    stageId,
    "llmFilter",
    "llm",
    stageMeta(baseOpts, { concurrency })
  );

  return async function* (src, { onError = defaultOnError } = {}) {
    let idx = 0;

    for await (const item of src) {

      /* ---------- derive payload & prompt for logging ---------- */
      const payload  = baseOpts.pre ? baseOpts.pre(item) : (item as unknown as Pay);
      const messages = judgePrompt(payload);

      const started  = Date.now();
      const cid      = startCall(stageId, idx++, item, messages);

      /* ---------- call transform() with full opts ---------- */
      // 1. splice the prompt into a fresh opts object
      const tOpts: TransformOpts<boolean, A, Pay> = {
        ...baseOpts,
        prompt: judgePrompt,
      };

      await pool.acquire();
      try {
        const res  = await transform<boolean, A, Pay>(item, tOpts);
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


/* ------------------------------------------------------------------ */
/* LLM select – pair-wise tournament until only k items remain        */
/* ------------------------------------------------------------------ */
function llmSelectStage<A>(
  k: number,
  duelPrompt : (a: A, b: A) => ChatMsg[],
  baseOpts   : TransformOpts<A, { a: A; b: A }> & { model: string },
  concurrency = 4,
): Stage<A, A> {

  type Pair = { a: A; b: A };

  const pool     = new Semaphore(concurrency);
  const stageId  = newStageId();

  registerStage(
    stageId,
    "llmSelect",
    "llm",
    stageMeta(baseOpts, { k, concurrency })
  );

  return async function* (src, { onError = defaultOnError } = {}) {
    /* ---------- 1. Buffer everything upstream ---------- */
    const buf: A[] = [];
    for await (const it of src) buf.push(it);
    if (buf.length <= k) {
      const cid = startCall(stageId, 0, { count: buf.length }, []);
      endCall(cid, true, "pass-through", undefined, Date.now());
      for (const it of buf) yield it;
      return;
    }


    let duelIdx = 0;

    /* ---------- 2. Repeatedly duel until k remain ---------- */
    while (buf.length > k) {
      const pairs = Math.min(concurrency, buf.length - k);
      const tasks: Promise<A>[] = [];

      for (let i = 0; i < pairs && buf.length > 1; i++) {
        const a = buf.shift()!, b = buf.shift() ?? a;
        const pair: Pair = { a, b };

        /* ---- prompt & logging ---- */
        const messages = duelPrompt(a, b);
        const started  = Date.now();
        const cid      = startCall(stageId, duelIdx++, pair, messages);

        /* ---- launch a concurrent duel ---- */
        await pool.acquire();
        tasks.push((async () => {
          /* compose per-duel opts to splice in the prompt fn */
          const duelOpts: TransformOpts<A, Pair> = {
            ...baseOpts,
            prompt: (p: Pair) => duelPrompt(p.a, p.b),
          };

          try {
            const res    = await transform<A, Pair>(pair, duelOpts);
            const winner = res.ok ? (res.content as A) : a;

            endCall(cid, true, winner, undefined, started);
            return winner;

          } catch (e) {
            endCall(cid, false, undefined, (e as Error).message, started);
            onError(e as Error, { stage: "llmSelect" });
            return a;                        // default winner on error

          } finally {
            pool.release();
          }
        })());
      }

      buf.push(...await Promise.all(tasks));    // winners back in the pool
    }

    /* ---------- 3. Emit the survivors ---------- */
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

  /* CPU ops */
  map<B>(fn: (a: A) => B | Promise<B>, c = Infinity): Flow<B> {
    return new Flow(chain(this.stage, mapStage(fn, c)), this.opts);
  }
  filter(pred: (a: A) => boolean | Promise<boolean>, c = Infinity): Flow<A> {
    return new Flow(chain(this.stage, filterStage(pred, c)), this.opts);
  }
  fold<B>(seed: B, fn: (acc: B, a: A) => B | Promise<B>): Flow<B> {
    return new Flow(chain(this.stage, foldStage(seed, fn)), this.opts);
  }


    /* ---------- 1. Map: one LLM call per item ---------- */
    llmMap<B>(
      promptFn: (a: A) => ChatMsg[],
      opts: TransformOpts<B, A> & { model: string },
      c = 8,
    ): Flow<B> {
      const fullOpts = { ...opts, prompt: promptFn };
      return new Flow(chain(this.stage, llmMapStage<A, B>(fullOpts, c)), this.opts);
    }

    /* ---------- 2. Filter: judge KEEP / SKIP ---------- */
    llmFilter(
      judgePrompt: (a: A) => ChatMsg[],
      opts: TransformOpts<boolean, A> & { model: string },
      c = 8,
    ): Flow<A> {
      return new Flow(
        chain(this.stage, llmFilterStage<A>(judgePrompt, opts, c)),
        this.opts,
      );
    }

    /* ---------- 3. Select: tournament to top-k ---------- */
    llmSelect(
      k: number,
      duelPrompt: (a: A, b: A) => ChatMsg[],
      opts: TransformOpts<A, { a: A; b: A }> & { model: string },
      c = 4,
    ): Flow<A> {
      return new Flow(
        chain(this.stage, llmSelectStage<A>(k, duelPrompt, opts, c)),
        this.opts,
      );
    }

    /* ---------- 4. Reduce: fold via an LLM ---------- */
    async llmReduce<B>(
      foldPrompt: (acc: B, a: A) => ChatMsg[],
      seed: B,
      opts: TransformOpts<B, A> & { model: string },
    ): Promise<B> {
      let acc = seed;

      for await (const item of this.stage(asyncEmpty(), this.opts)) {
        /* build a per-iteration opts object that captures acc & item */
        const iterOpts: TransformOpts<B, A> = {
          ...opts,
          pre   : opts.pre ?? (s => s),                    // identity if absent
          prompt: () => foldPrompt(acc, item),
          post  : opts.post,                               // reuse if any
        };

        const res = await transform<B, A>(item, iterOpts);
        if (res.ok) acc = res.content as B;
        else this.opts.onError?.(res.error!, { stage: "llmReduce" });
      }
      return acc;
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
