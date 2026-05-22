// Client-side dedup buffer for resume events.
// The server-side WsResumeBuffer holds events for replay; this buffer holds
// recently-seen eventIds and the last sequence number so the client can
// silently drop duplicates that arrive during a reconnect race or
// best-effort replay storm.
//
// Backed by an insertion-ordered Set so eviction is O(1). Last-sequence is
// tracked separately because sequence numbers can repeat across reconnects
// to the same apiKeyId (server resets per-socket lastSentSeq on each
// connection) and the eventId Set is the authoritative dedup signal.

const DEFAULT_MAX_SIZE = 200;

export class ResumeBuffer {
  private readonly maxSize: number;
  // Insertion-ordered set. JS Set iteration order is insertion order; we use
  // that to evict the oldest entry when the cap is hit.
  private readonly seen = new Set<string>();
  // Highest sequence seen so far. Used to detect gaps and drop replays.
  // Initialized to -1 so the first event with sequence 0 is always accepted.
  private lastSequence = -1;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new Error('ResumeBuffer: maxSize must be >= 1');
    }
    this.maxSize = Math.floor(maxSize);
  }

  // True when the eventId has already been seen. O(1).
  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  // Record an eventId. Evicts the oldest entry when at capacity. O(1) for
  // the add and O(1) amortized for the eviction (Set.values().next() is O(1)).
  add(eventId: string): void {
    if (this.seen.has(eventId)) {
      // Re-add to bump recency. Delete first so the new insertion lands at
      // the tail of the iteration order. This keeps frequently-seen ids
      // resilient against eviction.
      this.seen.delete(eventId);
      this.seen.add(eventId);
      return;
    }
    if (this.seen.size >= this.maxSize) {
      const oldest = this.seen.values().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
    this.seen.add(eventId);
  }

  // Highest sequence seen so far. Returns -1 if no events have been recorded.
  getLastSequence(): number {
    return this.lastSequence;
  }

  // Bump the high-water sequence. Idempotent: calling with a smaller value
  // is a no-op. Caller is responsible for handling out-of-order events
  // (typically by checking has() first to dedup, then bumping).
  recordSequence(seq: number): void {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    if (seq > this.lastSequence) {
      this.lastSequence = seq;
    }
  }

  // Drop all dedup state. Called on session.start so a new sessionId starts
  // with a clean slate; the server resets per-socket sequence to 0.
  clear(): void {
    this.seen.clear();
    this.lastSequence = -1;
  }

  // Number of eventIds currently held. Exposed for tests and metrics.
  size(): number {
    return this.seen.size;
  }

  // Most-recently-added eventId, or null when the buffer is empty. Used by
  // MerchantStream to populate the Last-Event-Id header on reconnect.
  // Backed by Set's insertion-ordered iteration; the last value wins.
  getLastEventId(): string | null {
    let last: string | null = null;
    for (const id of this.seen) {
      last = id;
    }
    return last;
  }
}
