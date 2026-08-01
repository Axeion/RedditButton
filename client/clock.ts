/**
 * Clock synchronisation.
 *
 * The server broadcasts a deadline, not a countdown, so the client has to know
 * how far its own clock is from the server's. We sample with ping/pong and keep
 * the offset from the round trip with the LOWEST latency — that sample has the
 * least room for asymmetric delay, so it's the most trustworthy one we've seen.
 */
export class ClockSync {
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;

  /** Feed a completed round trip. `t0` is when we sent the ping. */
  sample(t0: number, serverTime: number): void {
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt < 0 || rtt > 10_000) return;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      // Assume symmetric latency: the server's clock at t1 was serverTime + rtt/2.
      this.offset = serverTime + rtt / 2 - t1;
    }
  }

  /** Best estimate of the server's current time. */
  now(): number {
    return Date.now() + this.offset;
  }

  /** After a reconnect the old samples describe a dead socket. */
  reset(): void {
    this.bestRtt = Number.POSITIVE_INFINITY;
  }

  get quality(): number {
    return this.bestRtt;
  }
}
