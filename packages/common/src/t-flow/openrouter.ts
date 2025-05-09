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

export interface CallOpts<T = string> {
  /* LLM behaviour */
  temperature?: number;                     // default 0.7
  max_tokens?: number;
  response_format?: { type: "json_object" };/* strict-JSON mode */

  /* Reliability */
  retries?: number;                         // default 3
  abortAfter?: number;                      // ms timeout
  backoff?: (attempt: number) => number;    // override back-off

  /* Post-processing */
  parse?: (raw: string) => T;               // text -> typed value
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
export async function call<T = string>(
  model: string,
  messages: ChatMsg[],
  opts: CallOpts<T> = {},
): Promise<LLMResult<T>> {

  const {
    temperature = 0.7,
    max_tokens,
    response_format,
    retries      = 3,
    abortAfter,
    backoff      = defaultBackoff,
    parse,
  } = opts;

  const controller = new AbortController();
  if (abortAfter) {
    // unref() so the timer doesn't keep Node alive (optional)
    setTimeout(() => controller.abort(), abortAfter).unref?.();
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens,
          ...(response_format ? { response_format } : {}),
        }),
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${rawBody}`);
      }

      const data     = JSON.parse(rawBody);
      const rawText  = String(data.choices[0].message.content);

      let content: any = rawText;
      if (parse) {
        try {
          content = parse(rawText);
        } catch (e) {
          throw new Error(`Parse error: ${(e as Error).message}`);
        }
      }

      return { ok: true, content, raw: rawText };
    } catch (err) {
      if (attempt === retries) {
        return { ok: false, raw: "", error: err as Error };
      }
    }
    await new Promise((r) => setTimeout(r, backoff(attempt)));
  }

  /* Should never reach here */
  return { ok: false, raw: "", error: new Error("unreachable") };
}
