export class Semaphore {
  private queue: Array<() => void> = [];
  private count: number;
  constructor(max: number) { this.count = max; }
  async acquire() {
    if (this.count > 0) { this.count--; return; }
    return new Promise<void>(r => this.queue.push(r));
  }
  release() {
    this.count++;
    if (this.queue.length) this.queue.shift()!();
  }
}


export const defaultBackoff = (attempt: number) =>
  500 * 2 ** attempt + Math.random() * 100;

export class LLMError extends Error {
  constructor(msg: string, public cause?: unknown) { super(msg); }
}
