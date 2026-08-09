import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrchestratorService } from './orchestrator.service';

/**
 * Covers the retry classification and circuit-breaker integration of the one
 * outbound gateway. `retryDelayMs` is 0 so the exponential backoff sleeps
 * resolve on the next tick — no timer juggling needed.
 */
describe('OrchestratorService transport', () => {
  const config = {
    values: {
      'orchestrator.baseUrl': 'http://orchestrator.test',
      'orchestrator.apiKey': undefined as string | undefined,
      'orchestrator.timeoutMs': 1000,
      'orchestrator.previewTimeoutMs': 60_000,
      'orchestrator.maxRetries': 2,
      'orchestrator.retryDelayMs': 0,
      'orchestrator.circuitBreaker.failureThreshold': 2,
      'orchestrator.circuitBreaker.openMs': 10_000,
    } as Record<string, unknown>,
    get<T>(key: string): T {
      return this.values[key] as T;
    },
  };

  let http: { request: jest.Mock };
  let service: OrchestratorService;

  const axiosError = (status?: number) => ({
    isAxiosError: true,
    message: status ? `HTTP ${status}` : 'timeout',
    response: status ? { status } : undefined,
  });

  beforeEach(() => {
    http = { request: jest.fn() };
    service = new OrchestratorService(http as never, config as never);
  });

  it('returns the payload on a first-try success without retrying', async () => {
    http.request.mockReturnValue(of({ data: { score: 42 } }));

    await expect(service.scoreRisk({ customerId: 'c1' })).resolves.toEqual({
      score: 42,
    });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx and succeeds on a later attempt', async () => {
    http.request
      .mockReturnValueOnce(throwError(() => axiosError(500)))
      .mockReturnValueOnce(throwError(() => axiosError(503)))
      .mockReturnValueOnce(of({ data: { score: 7 } }));

    await expect(service.scoreRisk({ customerId: 'c1' })).resolves.toEqual({
      score: 7,
    });
    expect(http.request).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it.each([408, 429])('retries a transient %i', async (status) => {
    http.request
      .mockReturnValueOnce(throwError(() => axiosError(status)))
      .mockReturnValueOnce(of({ data: { score: 5 } }));

    await expect(service.scoreRisk({ customerId: 'c1' })).resolves.toEqual({
      score: 5,
    });
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  /**
   * The fitting call opts out of both shared defaults. A generative try-on takes
   * 10-30s, so the 15s default guaranteed a timeout on every successful render;
   * and because the orchestrator anchors renders on a deterministic request_id, a
   * retry cannot make a slow render faster — it only stacks another full timeout
   * onto a customer who is already waiting.
   */
  describe('generatePreview', () => {
    const preview = {
      customerId: 'c1',
      productId: 'p1',
      customerPhotoUrl: 'https://x/y.jpg',
    };

    it('uses the longer render budget, not the shared timeout', async () => {
      http.request.mockReturnValue(of({ data: { previewPhotoUrl: 'u' } }));

      await service.generatePreview(preview);

      expect(http.request).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it('does not retry — a slow render is not made faster by asking twice', async () => {
      http.request.mockReturnValue(throwError(() => axiosError(504)));

      await expect(service.generatePreview(preview)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(http.request).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT retry a deterministic 4xx', async () => {
    http.request.mockReturnValue(throwError(() => axiosError(400)));

    await expect(
      service.scoreRisk({ customerId: 'c1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('retries a network timeout (no response)', async () => {
    http.request
      .mockReturnValueOnce(throwError(() => axiosError(undefined)))
      .mockReturnValueOnce(of({ data: { score: 1 } }));

    await expect(service.scoreRisk({ customerId: 'c1' })).resolves.toEqual({
      score: 1,
    });
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries then throws 503, having tried maxRetries + 1 times', async () => {
    http.request.mockReturnValue(throwError(() => axiosError(500)));

    await expect(
      service.scoreRisk({ customerId: 'c1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.request).toHaveBeenCalledTimes(3); // maxRetries (2) + 1
  });

  it('forwards the idempotency key as a header on payment-link creation', async () => {
    http.request.mockReturnValue(of({ data: { paymentId: 'pay_1' } }));

    await service.createPaymentLink({
      orderId: 'o1',
      customerId: 'c1',
      amount: 10,
      currency: 'TND',
      idempotencyKey: 'deposit:o1',
    });

    const cfg = http.request.mock.calls[0][0];
    expect(cfg.headers['Idempotency-Key']).toBe('deposit:o1');
  });

  it('opens the breaker after repeated failures and then fails fast', async () => {
    http.request.mockReturnValue(throwError(() => axiosError(500)));

    // Two failed requests (threshold = 2). Each exhausts its own retries.
    await expect(service.scoreRisk({ customerId: 'c1' })).rejects.toThrow();
    await expect(service.scoreRisk({ customerId: 'c1' })).rejects.toThrow();
    expect(service.breakerState.state).toBe('OPEN');

    const callsBefore = http.request.mock.calls.length;
    // Third request must short-circuit without touching the transport.
    await expect(
      service.scoreRisk({ customerId: 'c1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.request.mock.calls.length).toBe(callsBefore);
  });

  it('ping() returns false instead of throwing when the probe fails', async () => {
    http.request.mockReturnValue(throwError(() => axiosError(500)));
    await expect(service.ping()).resolves.toBe(false);
  });

  it('ping() returns true on a reachable orchestrator', async () => {
    http.request.mockReturnValue(of({ data: { status: 'ok' } }));
    await expect(service.ping()).resolves.toBe(true);
  });
});
