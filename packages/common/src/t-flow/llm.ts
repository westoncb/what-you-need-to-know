// llm.ts --------------------------------------------------------------
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

/* -------------------------------------------------------------------- */
/* Types                                                                */
/* -------------------------------------------------------------------- */
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TransformOpts<
  Out = string,
  Src = unknown,
  Pay = Src            // “payload” after pre() transforms
> {
  /* Model selection & low-level knobs */
  model: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };

  /* Reliability */
  retries?: number;
  abortAfter?: number;
  backoff?: (attempt: number) => number;

  /* High-level hooks */
  /**
   * pre:  Src → Pay       (optional)
   *       Produce the payload you’ll build the prompt from.
   */
  pre?: (src: Src) => Pay;

  /**
   * prompt: Pay → ChatMsg[]
   *         Turn the payload into the actual prompt.
   */
  prompt: (pay: Pay) => ChatMsg[];

  /**
   * post: rawText × Src × Pay  →  Out   (optional)
   *       Parse / trim / merge with original item as you please.
   *       If omitted, raw string is returned.
   */
  post?: (raw: string, src: Src, pay: Pay) => Out;
}

export interface LLMResult<T = string> {
  ok: boolean;
  content?: T;    // parsed (or raw) result when ok === true
  raw: string;    // verbatim assistant text
  error?: Error;  // populated on failure
}

/* -------------------------------------------------------------------- */
/* Constants & helpers                                                  */
/* -------------------------------------------------------------------- */
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const API_KEY  = process.env.OPENROUTER_API_KEY;

if (!API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing in environment");
}

const defaultBackoff = (attempt: number) =>
  500 * 2 ** attempt + Math.random() * 100;

/* -------------------------------------------------------------------- */
/* Core wrapper                                                         */
/* -------------------------------------------------------------------- */
export async function transform<Out = string, Src = unknown, Pay = Src>(
  src: Src,
  opts: TransformOpts<Out, Src, Pay>,
): Promise<LLMResult<Out>> {
  const {
    model, temperature = 0.7, max_tokens, response_format,
    retries = 3, abortAfter, backoff = defaultBackoff,
    pre, prompt, post,
  } = opts;

  /* -------- build prompt -------- */
  const payload  = pre ? pre(src) : (src as unknown as Pay);
  const messages = prompt(payload);

  /* -------- identical retry loop -------- */
  const controller = new AbortController();
  if (abortAfter) setTimeout(() => controller.abort(), abortAfter).unref?.();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method : "POST",
        signal : controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization : `Bearer ${API_KEY}`,
        },
        body   : JSON.stringify({
          model, messages, temperature, max_tokens,
          ...(response_format ? { response_format } : {}),
        }),
      });

      const rawBody = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${rawBody}`);

      const data    = JSON.parse(rawBody);
      const rawText = String(data.choices[0].message.content);

      /* -------- post-processing -------- */
      let content: any = rawText;
      if (post) {
        try       { content = post(rawText, src, payload); }
        catch (e) { throw new Error(`post() error: ${(e as Error).message}`); }
      }

      return { ok: true, content, raw: rawText };
    } catch (err) {
      if (attempt === retries) return { ok: false, raw: "", error: err as Error };
    }
    await new Promise(r => setTimeout(r, backoff(attempt)));
  }
  return { ok: false, raw: "", error: new Error("unreachable") };
}
