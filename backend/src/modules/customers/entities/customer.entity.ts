import { ApiProperty } from '@nestjs/swagger';
import { RiskTier } from '../../../common/enums';

/**
 * Supabase table: `customers`.
 * Aggregate refusal history drives the risk engine.
 */
export class Customer {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  seller_id: string;

  @ApiProperty({ example: '+21620123456' })
  phone: string;

  @ApiProperty({ example: 'Amine Ben Salah', nullable: true })
  name: string | null;

  @ApiProperty({ example: 12 })
  total_orders: number;

  @ApiProperty({ example: 10 })
  successful_orders: number;

  @ApiProperty({ example: 2 })
  refused_orders: number;

  @ApiProperty({ enum: RiskTier, example: RiskTier.MEDIUM })
  risk_tier: RiskTier;

  @ApiProperty({ example: 'Tunis', nullable: true, required: false })
  zone?: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
