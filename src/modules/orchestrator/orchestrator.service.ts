import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import { CircuitBreaker } from '../../common/utils/circuit-breaker';
import {
  CreatePaymentLinkRequest,
  CreatePaymentLinkResponse,
  GeneratePreviewRequest,
  GeneratePreviewResponse,
  RiskScoreRequest,
  RiskScoreResponse,
} from './dto/orchestrator-contracts';

/**
 * The single outbound gateway from the NestJS core to the Codlock
 * Orchestrator Agent. Every AI-facing capability (fitting, risk, payment)
 * is proxied through here so that resilience — timeout, bounded retries with
 * backoff, and a circuit breaker — is applied uniformly.
 *
 *   [ NestJS Core ] --HTTP--> [ Codlock Orchestrator ] --A2A--> { agents/tools }
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('orchestrator.baseUrl') as string;
    this.apiKey = this.config.get<string>('orchestrator.apiKey');
    this.timeoutMs = this.config.get<number>('orchestrator.timeoutMs') as number;
    this.maxRetries = this.config.get<number>('orchestrator.maxRetries') as number;
    this.retryDelayMs = this.config.get<number>(
      'orchestrator.retryDelayMs',
    ) as number;

    this.breaker = new CircuitBreaker(
      'orchestrator',
      this.config.get<number>('orchestrator.circuitBreaker.failureThreshold') as number,
      this.config.get<number>('orchestrator.circuitBreaker.openMs') as number,
    );
  }

  // ── Public capabilities ────────────────────────────────────

  /** Module 3 — trigger the Fitting Agent to render a try-on preview. */
  generatePreview(body: GeneratePreviewRequest): Promise<GeneratePreviewResponse> {
    return this.post<GeneratePreviewResponse>('/agent/fitting/generate-preview', body);
  }

  /** Module 4 — ask the Risk Scoring Tool for a 0–100 score. */
  scoreRisk(body: RiskScoreRequest): Promise<RiskScoreResponse> {
    return this.post<RiskScoreResponse>('/agent/risk/score', body);
  }

  /** Module 5 — ask the Payment Agent (→ gravvfi/mcp) for a deposit link. */
  createPaymentLink(
    body: CreatePaymentLinkRequest,
  ): Promise<CreatePaymentLinkResponse> {
    return this.post<CreatePaymentLinkResponse>('/agent/payment/create-link', body);
  }

  /** Liveness probe for the health module. */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>({ method: 'GET', url: '/health' });
      return true;
    } catch {
      return false;
    }
  }

  get breakerState() {
    return this.breaker.snapshot;
  }

  // ── Internal transport ─────────────────────────────────────

  private post<T>(path: string, data: unknown): Promise<T> {
    return this.request<T>({ method: 'POST', url: path, data });
  }

  /**
   * Executes an HTTP call to the orchestrator wrapped in the circuit breaker,
   * with bounded exponential-backoff retries on transient failures only.
   */
  private async request<T>(cfg: AxiosRequestConfig): Promise<T> {
    return this.breaker.execute(() => this.withRetries<T>(cfg));
  }

  private async withRetries<T>(cfg: AxiosRequestConfig): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const response = await firstValueFrom(
          this.http.request<T>({
            baseURL: this.baseUrl,
            timeout: this.timeoutMs,
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
            },
            ...cfg,
          }),
        );
        return response.data;
      } catch (err) {
        lastErr = err;
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        // Do not retry deterministic client errors (4xx except 408/429).
        const retriable =
          !status || status >= 500 || status === 408 || status === 429;

        if (!retriable || attempt === this.maxRetries) break;

        const backoff = this.retryDelayMs * 2 ** attempt;
        this.logger.warn(
          `Orchestrator ${cfg.method} ${cfg.url} failed (attempt ${attempt + 1}/${
            this.maxRetries + 1
          }, status=${status ?? 'timeout'}). Retrying in ${backoff}ms.`,
        );
        await this.sleep(backoff);
        attempt += 1;
      }
    }

    const axiosErr = lastErr as AxiosError;
    this.logger.error(
      `Orchestrator ${cfg.method} ${cfg.url} exhausted retries: ${axiosErr?.message}`,
    );
    throw new ServiceUnavailableException(
      'Codlock Orchestrator is currently unavailable. Please retry shortly.',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
