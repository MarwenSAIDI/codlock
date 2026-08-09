import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { CustomersService } from '../customers/customers.service';
import { FirebaseService } from '../../database/firebase/firebase.service';
import { RiskTier } from '../../common/enums';
import { EvaluateRiskDto } from './dto/evaluate-risk.dto';
import { RiskResult } from './dto/risk-result.dto';

/**
 * Module 4 — Risk Scoring & Dynamic Deposit Engine.
 *
 * Delegates the numeric score to the Orchestrator's Risk Scoring Tool
 * (Firebase-backed history). If that service is degraded, it falls back to a
 * local heuristic from the customer's own aggregates so an order can still
 * progress — the deposit simply defaults to the safe (higher) side.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private readonly rates: { trusted: number; medium: number; high: number };
  private readonly thresholds: { high: number; medium: number };

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly customers: CustomersService,
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {
    this.rates = this.config.get('risk.depositRates') as typeof this.rates;
    this.thresholds = this.config.get(
      'risk.thresholds',
    ) as typeof this.thresholds;
  }

  async evaluate(sellerId: string, dto: EvaluateRiskDto): Promise<RiskResult> {
    const customer = await this.customers.findOneForSeller(
      sellerId,
      dto.customerId,
    );

    let score: number;
    let factors: Record<string, unknown> | undefined;

    try {
      const remote = await this.orchestrator.scoreRisk({
        customerId: dto.customerId,
        phone: customer.phone,
        zone: dto.zone ?? customer.zone ?? undefined,
        channel: dto.channel,
        orderValue: dto.orderValue,
      });
      score = this.clamp(remote.score);
      factors = remote.factors;
    } catch (err) {
      // Circuit open / timeout — degrade gracefully to a local estimate.
      this.logger.warn(
        `Risk Scoring Tool unavailable, using local fallback: ${(err as Error).message}`,
      );
      score = this.localHeuristic(
        customer.refused_orders,
        customer.total_orders,
      );
      factors = { fallback: true };
    }

    const tier = this.tierFor(score);
    const depositRate = this.rateFor(tier);
    const depositAmount = this.round2(dto.orderValue * depositRate);

    // Fire-and-forget analytics event.
    void this.firebase.logEvent('risk_evaluations', {
      customerId: dto.customerId,
      score,
      tier,
      depositRate,
      orderValue: dto.orderValue,
      zone: dto.zone ?? customer.zone ?? null,
    });

    return { score, tier, depositRate, depositAmount, factors };
  }

  // ── Helpers ────────────────────────────────────────────────

  private tierFor(score: number): RiskTier {
    if (score >= this.thresholds.high) return RiskTier.HIGH;
    if (score >= this.thresholds.medium) return RiskTier.MEDIUM;
    return RiskTier.TRUSTED;
  }

  private rateFor(tier: RiskTier): number {
    switch (tier) {
      case RiskTier.HIGH:
        return this.rates.high;
      case RiskTier.MEDIUM:
        return this.rates.medium;
      default:
        return this.rates.trusted;
    }
  }

  /** First-time buyers are treated as elevated risk (65) by default. */
  private localHeuristic(refused: number, total: number): number {
    if (total === 0) return 65;
    const refusalRate = refused / total;
    return this.clamp(Math.round(refusalRate * 100));
  }

  private clamp(n: number): number {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
