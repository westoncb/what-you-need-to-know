export class Semaphore {
  private queue: Array<() => void> = [];
  private count: number;
  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("Concurrency must be a positive integer.");
    this.count = max;
  }
  async acquire() {
    if (this.count > 0) { this.count--; return; }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); // Transfer this permit directly to the waiting caller.
    else this.count++;
  }
}

export const defaultBackoff = (attempt: number) =>
  500 * 2 ** attempt + Math.random() * 100;

export interface LLMErrorDetails {
  kind: "http" | "network" | "timeout" | "invalid-response" | "configuration";
  retryable?: boolean;
  status?: number;
  code?: string | number;
  providerCode?: string | number;
  errorType?: string;
  retryAfterMs?: number;
}

export class LLMError extends Error {
  readonly kind: LLMErrorDetails["kind"];
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string | number;
  readonly providerCode?: string | number;
  readonly errorType?: string;
  readonly retryAfterMs?: number;
  attempts = 0;
  raw = "";

  constructor(message: string, public cause?: unknown, details: LLMErrorDetails = { kind: "network" }) {
    super(message);
    this.name = "LLMError";
    this.kind = details.kind;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.code = details.code;
    this.providerCode = details.providerCode;
    this.errorType = details.errorType;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/** Throw from post() when another model response could satisfy the contract. */
export class InvalidResponseError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, cause, { kind: "invalid-response", retryable: true });
    this.name = "InvalidResponseError";
  }
}
