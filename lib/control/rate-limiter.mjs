// AVC Studio P0 Step 5B — testable in-memory sliding-window rate limiter.
// Injectable clock; no persistence. Used to bound pairing/rotation/auth attempts.

export class RateLimiter {
  constructor({ clock } = {}) { this._clock = typeof clock === "function" ? clock : () => Date.now(); this._buckets = new Map(); }

  // hit(key, {max, windowMs}) -> { allowed, remaining }. Records the attempt iff allowed.
  hit(key, { max, windowMs }) {
    const now = this._clock();
    const arr = (this._buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this._buckets.set(key, arr); return { allowed: false, remaining: 0 }; }
    arr.push(now); this._buckets.set(key, arr);
    return { allowed: true, remaining: max - arr.length };
  }
  reset(key) { this._buckets.delete(key); }
  clear() { this._buckets.clear(); }
}
