// flow.ts ─────────────────────────────────────────────────────────────
import { call, ChatMsg, CallOpts } from "./openrouter";
import { Semaphore }               from "./flow-utils";

/* ------------------------------------------------------------------ */
/* Stage abstraction                                                  */
/* ------------------------------------------------------------------ */
type Stage<I, O> = (items: I[]) => Promise<O[]>;

/** Compose two stages: s1 ➜ s2 */
function chain<A, B, C>(s1: Stage<A, B>, s2: Stage<B, C>): Stage<A, C> {
  return async (items: A[]) => s2(await s1(items));
}

/* ------------------------------------------------------------------ */
/* Small stage builders                                               */
/* ------------------------------------------------------------------ */
function mapStage<A, B>(
  fn: (a: A) => B | Promise<B>,
): Stage<A, B> {
  return async (items) => Promise.all(items.map(fn));
}

function filterStage<A>(
  pred: (a: A) => boolean | Promise<boolean>,
): Stage<A, A> {
  return async (items) => {
    const keep = await Promise.all(items.map(pred));
    return items.filter((_, i) => keep[i]);
  };
}

function llmMapStage<A, B>(
  model: string,
  promptFn: (a: A) => ChatMsg[],
  opts: CallOpts<B>,
  maxConcurrency = 8,
): Stage<A, B> {
  const pool = new Semaphore(maxConcurrency);

  return async (items) =>
    Promise.all(
      items.map(async (item) => {
        await pool.acquire();
        try {
          const res = await call<B>(model, promptFn(item), opts);
          if (!res.ok) throw res.error;
          return res.content as B;
        } finally {
          pool.release();
        }
      }),
    );
}

function llmFilterStage<A>(
  model: string,
  judgePrompt: (a: A) => ChatMsg[],
  opts: CallOpts<boolean>,
  maxConcurrency = 8,
): Stage<A, A> {
  const pool = new Semaphore(maxConcurrency);

  return async (items) => {
    const verdicts = await Promise.all(
      items.map(async (item) => {
        await pool.acquire();
        try {
          const res = await call<boolean>(model, judgePrompt(item), opts);
          if (!res.ok) throw res.error;
          return Boolean(res.content);
        } finally {
          pool.release();
        }
      }),
    );
    return items.filter((_, i) => verdicts[i]);
  };
}

function llmSelectStage<A>(
  k: number,
  model: string,
  duelPrompt: (a: A, b: A) => ChatMsg[],
  opts: CallOpts<A>,
): Stage<A, A> {
  return async function select(items: A[]): Promise<A[]> {
    if (k >= items.length) return [...items];

    let pool = [...items];
    while (pool.length > k) {
      const next: A[] = [];
      for (let i = 0; i < pool.length; i += 2) {
        const a = pool[i];
        const b = pool[i + 1] ?? a;      // odd man advances automatically
        const res = await call<A>(model, duelPrompt(a, b), opts);
        next.push(res.ok ? (res.content as A) : a);
      }
      pool = next;
    }
    return pool.slice(0, k);
  };
}

/* ------------------------------------------------------------------ */
/* Flow class                                                         */
/* ------------------------------------------------------------------ */
export class Flow<A> {
  private constructor(private readonly stage: Stage<any, A>) {}

  /** Entry point */
  static from<A>(iterable: Iterable<A>): Flow<A> {
    const base: Stage<unknown, A> = async () => [...iterable];
    return new Flow(base);
  }

  /* ---------------- CPU combinators ------------------------------- */
  map<B>(fn: (a: A) => B | Promise<B>): Flow<B> {
    return new Flow(chain(this.stage, mapStage(fn)));
  }

  filter(pred: (a: A) => boolean | Promise<boolean>): Flow<A> {
    return new Flow(chain(this.stage, filterStage(pred)));
  }

  /** Terminal CPU reduce (scalar result) */
  async reduce<B>(
    fold: (acc: B, a: A) => B | Promise<B>,
    seed: B,
  ): Promise<B> {
    const items = await this.stage([]);
    let acc = seed;
    for (const item of items) acc = await fold(acc, item);
    return acc;
  }

  /* ---------------- LLM combinators ------------------------------- */
  llmMap<B>(
    model: string,
    promptFn: (a: A) => ChatMsg[],
    opts: CallOpts<B> = {},
    maxConcurrency = 8,
  ): Flow<B> {
    return new Flow(
      chain(this.stage, llmMapStage(model, promptFn, opts, maxConcurrency)),
    );
  }

  llmFilter(
    model: string,
    judgePrompt: (a: A) => ChatMsg[],
    opts: CallOpts<boolean> = {},
    maxConcurrency = 8,
  ): Flow<A> {
    return new Flow(
      chain(
        this.stage,
        llmFilterStage(model, judgePrompt, opts, maxConcurrency),
      ),
    );
  }

  llmSelect(
    k: number,
    model: string,
    duelPrompt: (a: A, b: A) => ChatMsg[],
    opts: CallOpts<A> = {},
  ): Flow<A> {
    return new Flow(
      chain(this.stage, llmSelectStage(k, model, duelPrompt, opts)),
    );
  }

  /** Terminal LLM reduce (scalar result) */
  async llmReduce<B>(
    model: string,
    foldPrompt: (acc: B, a: A) => ChatMsg[],
    seed: B,
    opts: CallOpts<B> = {},
  ): Promise<B> {
    const items = await this.stage([]);
    let acc = seed;
    for (const item of items) {
      const res = await call<B>(model, foldPrompt(acc, item), opts);
      if (res.ok) acc = res.content as B;
      else throw res.error;
    }
    return acc;
  }

  /* ---------------- Execution ------------------------------- */
  run(): Promise<A[]> {
    return this.stage([]);
  }
}
