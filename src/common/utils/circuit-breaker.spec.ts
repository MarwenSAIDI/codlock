import { ServiceUnavailableException } from '@nestjs/common';
import { CircuitBreaker } from './circuit-breaker';

/**
 * The breaker is what stops the backend from hammering a dead orchestrator and
 * from making callers wait on calls that will fail anyway. Its state machine is
 * exercised directly here rather than only through OrchestratorService.
 */
describe('CircuitBreaker', () => {
  const ok = () => Promise.resolve('value');
  const boom = () => Promise.reject(new Error('downstream failed'));

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes calls through and returns their value while CLOSED', async () => {
    const cb = new CircuitBreaker('t', 3, 1000);
    await expect(cb.execute(ok)).resolves.toBe('value');
    expect(cb.snapshot).toEqual({ state: 'CLOSED', failures: 0 });
  });

  it('counts consecutive failures without opening below the threshold', async () => {
    const cb = new CircuitBreaker('t', 3, 1000);
    await expect(cb.execute(boom)).rejects.toThrow('downstream failed');
    await expect(cb.execute(boom)).rejects.toThrow('downstream failed');
    expect(cb.snapshot).toEqual({ state: 'CLOSED', failures: 2 });
  });

  it('opens after the threshold and then fails fast without calling fn', async () => {
    const cb = new CircuitBreaker('t', 3, 1000);
    const fn = jest.fn(boom);

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fn)).rejects.toThrow('downstream failed');
    }
    expect(cb.snapshot.state).toBe('OPEN');
    expect(fn).toHaveBeenCalledTimes(3);

    // While open, the guarded fn must not run at all.
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a success resets the consecutive-failure count', async () => {
    const cb = new CircuitBreaker('t', 3, 1000);
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(ok)).resolves.toBe('value');
    expect(cb.snapshot).toEqual({ state: 'CLOSED', failures: 0 });

    // Two more failures should not trip it — the count restarted.
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();
    expect(cb.snapshot.state).toBe('CLOSED');
  });

  it('moves to HALF_OPEN after the cooldown and closes on a trial success', async () => {
    const cb = new CircuitBreaker('t', 2, 1000);
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();
    expect(cb.snapshot.state).toBe('OPEN');

    // Still open before the cooldown elapses.
    jest.advanceTimersByTime(999);
    await expect(cb.execute(ok)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Cooldown elapsed → one trial call is allowed, and success closes it.
    jest.advanceTimersByTime(1);
    await expect(cb.execute(ok)).resolves.toBe('value');
    expect(cb.snapshot).toEqual({ state: 'CLOSED', failures: 0 });
  });

  it('re-opens if the trial call in HALF_OPEN fails', async () => {
    const cb = new CircuitBreaker('t', 2, 1000);
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();

    jest.advanceTimersByTime(1000);
    // Trial call fails → straight back to OPEN.
    await expect(cb.execute(boom)).rejects.toThrow('downstream failed');
    expect(cb.snapshot.state).toBe('OPEN');

    // And it fails fast again immediately after.
    await expect(cb.execute(ok)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('opens exactly at the threshold, not before', async () => {
    const cb = new CircuitBreaker('t', 5, 1000);
    for (let i = 0; i < 4; i++) {
      await expect(cb.execute(boom)).rejects.toThrow('downstream failed');
    }
    expect(cb.snapshot.state).toBe('CLOSED');
    await expect(cb.execute(boom)).rejects.toThrow('downstream failed');
    expect(cb.snapshot.state).toBe('OPEN');
  });
});
