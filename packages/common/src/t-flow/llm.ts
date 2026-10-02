import fetch, { FetchError } from "node-fetch";
import dotenv from "dotenv";
import type { ModelSettings } from "../models";
import { defaultBackoff, InvalidResponseError, LLMError } from "./flow-utils";
export { InvalidResponseError, LLMError } from "./flow-utils";
dotenv.config();

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TransformOpts<Out = string, Src = unknown, Pay = Src> extends ModelSettings {
  /** Additional attempts after the first. Defaults to 3. */
  retries?: number;
  /** Per-attempt deadline, including the response body. Defaults to 120 seconds. */
  abortAfter?: number;
  backoff?: (attempt: number) => number;
  pre?: (src: Src) => Pay;
  prompt: (pay: Pay) => ChatMsg[];
  /** Throw InvalidResponseError for retryable validation failures; other errors propagate. */
  post?: (raw: string, src: Src, pay: Pay) => Out;
}

export type LLMResult<T = string> =
  | { ok: true; content: T; raw: string; attempts: number }
  | { ok: false; error: LLMError; raw: string; attempts: number };

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function httpError(status: number, body: string, retryAfter: number | undefined): LLMError {
  let error: any;
  try { error = JSON.parse(body)?.error; } catch { /* Non-JSON error bodies are still HTTP errors. */ }
  const code = error?.code;
  // Providers can return a failure envelope with an HTTP 200 response.
  const effectiveStatus = typeof code === "number" ? code : status;
  const retryable = [408, 429, 500, 502, 503, 504].includes(effectiveStatus) ||
    (effectiveStatus === 402 && error?.metadata?.limit_source === "openrouter_in_flight_budget" && retryAfter !== undefined);
  return new LLMError(`OpenRouter ${effectiveStatus}: ${error?.message || "Request failed"}`, undefined, {
    kind: "http", status, code, retryable, retryAfterMs: retryAfter,
    providerCode: error?.metadata?.provider_code,
    errorType: error?.metadata?.error_type,
  });
}

export async function transform<Out = string, Src = unknown, Pay = Src>(
  src: Src,
  opts: TransformOpts<Out, Src, Pay>,
): Promise<LLMResult<Out>> {
  const {
    model, temperature = 0.7, max_tokens, response_format,
    retries = 3, abortAfter = 120_000, backoff = defaultBackoff,
    pre, prompt, post,
  } = opts;
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be a nonnegative integer.");
  if (!Number.isFinite(abortAfter) || abortAfter <= 0) throw new RangeError("abortAfter must be positive milliseconds.");

  // Build exactly once. Exceptions here are programming errors, not model failures.
  const payload = pre ? pre(src) : (src as unknown as Pay);
  const messages = prompt(payload);
  const body = JSON.stringify({
    model, messages, temperature, max_tokens,
    ...(response_format ? { response_format } : {}),
  });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new LLMError("OPENROUTER_API_KEY missing in environment", undefined, { kind: "configuration" });
    return { ok: false, error, raw: "", attempts: 0 };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), abortAfter);
    timer.unref?.();
    let raw = "";
    let failure: LLMError;
    try {
      let response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body,
        });
        raw = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          throw new LLMError(`LLM request timed out after ${abortAfter}ms`, error, { kind: "timeout", retryable: true });
        }
        if (error instanceof FetchError) {
          throw new LLMError(error.message, error, { kind: "network", retryable: true, code: error.code });
        }
        throw error;
      }
      if (!response.ok) throw httpError(response.status, raw, retryAfterMs(response.headers.get("retry-after")));

      let data;
      try { data = JSON.parse(raw); }
      catch (error) { throw new InvalidResponseError("OpenRouter returned invalid JSON", error); }
      if (data?.error) throw httpError(response.status, raw, retryAfterMs(response.headers.get("retry-after")));

      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new InvalidResponseError("OpenRouter returned no text response");
      raw = content;
      if (choice.finish_reason === "length") {
        throw new LLMError("Model response reached its output token limit", undefined, {
          kind: "invalid-response", code: "length", retryable: false,
        });
      }
      if (choice.finish_reason === "content_filter" || choice.finish_reason === "error") {
        throw new LLMError(`Model response ended with ${choice.finish_reason}`, undefined, {
          kind: "invalid-response", code: choice.finish_reason, retryable: choice.finish_reason === "error",
        });
      }
      if (!raw.trim()) throw new InvalidResponseError("OpenRouter returned empty text");
      const output = post ? post(raw, src, payload) : raw as Out;
      return { ok: true, content: output, raw, attempts: attempt + 1 };
    } catch (error) {
      // In particular, an accidental TypeError/SyntaxError in post() is not retried.
      if (!(error instanceof LLMError)) throw error;
      failure = error;
      failure.attempts = attempt + 1;
      failure.raw = raw;
    } finally {
      clearTimeout(timer);
    }
    if (!failure.retryable || attempt === retries) {
      return { ok: false, error: failure, raw, attempts: attempt + 1 };
    }
    const delay = Math.max(backoff(attempt), failure.retryAfterMs ?? 0);
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("backoff must return nonnegative milliseconds.");
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Unreachable retry state");
}
