/** Active turn work has 120 seconds; human waits never reset the five-minute wall cap. */
export class NativeTurnDeadline {
  private remaining = 120000;
  private started = performance.now();
  private active?: ReturnType<typeof setTimeout>;
  private wall: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(readonly expire: (code: 'CODEX_TURN_TIMEOUT' | 'CODEX_WALL_TIMEOUT') => void) {
    this.arm();
    this.wall = setTimeout(() => this.stop('CODEX_WALL_TIMEOUT'), 300000);
  }
  private arm() {
    this.started = performance.now();
    this.active = setTimeout(() => this.stop('CODEX_TURN_TIMEOUT'), Math.max(0, this.remaining));
  }
  private stop(code: 'CODEX_TURN_TIMEOUT' | 'CODEX_WALL_TIMEOUT') {
    if (this.closed) return;
    this.dispose(); this.expire(code);
  }
  async approval<T>(wait: () => Promise<T>): Promise<T> {
    clearTimeout(this.active);
    this.remaining -= performance.now() - this.started;
    try { return await wait(); }
    finally { if (!this.closed) this.arm(); }
  }
  dispose() { this.closed = true; clearTimeout(this.active); clearTimeout(this.wall); }
}
