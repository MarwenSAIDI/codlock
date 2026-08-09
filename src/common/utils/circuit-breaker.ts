import { Logger, ServiceUnavailableException } from '@nestjs/common';

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Minimal circuit breaker for outbound calls to AI/external services.
 *
 * - CLOSED: calls pass through; consecutive failures are counted.
 * - OPEN: after `failureThreshold` failures, calls short-circuit for
 *   `openMs` and immediately throw 503 (no wasted latency on a dead service).
 * - HALF_OPEN: after the cooldown, one trial call is allowed; success closes
 *   the breaker, failure re-opens it.
 */
export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number,
    private readonly openMs: number,
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.openMs) {
        this.state = 'HALF_OPEN';
        this.logger.warn(`${this.name} entering HALF_OPEN (trial call)`);
      } else {
        throw new ServiceUnavailableException(
          `${this.name} is temporarily unavailable (circuit open)`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state !== 'CLOSED') {
      this.logger.log(`${this.name} recovered → CLOSED`);
    }
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.logger.error(
        `${this.name} tripped → OPEN for ${this.openMs}ms (failures=${this.failures})`,
      );
    }
  }

  get snapshot(): { state: BreakerState; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}
