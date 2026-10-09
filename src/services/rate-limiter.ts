/** Token bucket на ключ (telegram id). In-memory: достаточно для узкого круга. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    const refilled = Math.min(this.capacity, bucket.tokens + ((t - bucket.updatedAt) / 1000) * this.refillPerSec);
    const allowed = refilled >= 1;
    this.buckets.set(key, { tokens: allowed ? refilled - 1 : refilled, updatedAt: t });
    if (this.buckets.size > 10_000) this.gc(t);
    return allowed;
  }

  private gc(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.updatedAt > 60_000) this.buckets.delete(k);
  }
}
