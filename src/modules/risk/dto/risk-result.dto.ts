import { ApiProperty } from '@nestjs/swagger';
import { RiskTier } from '../../../common/enums';

/** Output of the deposit engine: what to charge and why. */
export class RiskResult {
  @ApiProperty({
    example: 62,
    description: 'Risk score 0 (safe) – 100 (high risk).',
  })
  score: number;

  @ApiProperty({ enum: RiskTier, example: RiskTier.MEDIUM })
  tier: RiskTier;

  @ApiProperty({
    example: 0.1,
    description: 'Deposit fraction of order value (0–1).',
  })
  depositRate: number;

  @ApiProperty({
    example: 14.99,
    description: 'Computed deposit amount in TND.',
  })
  depositAmount: number;

  @ApiProperty({
    required: false,
    description: 'Optional factor breakdown returned by the Risk Scoring Tool.',
  })
  factors?: Record<string, unknown>;
}
