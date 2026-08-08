import { ApiProperty } from '@nestjs/swagger';

export class ZoneRefusalStat {
  @ApiProperty({ example: 'Kairouan' })
  zone: string;

  @ApiProperty({ example: 14 })
  totalOrders: number;

  @ApiProperty({ example: 5 })
  refusedOrders: number;

  @ApiProperty({ example: 0.357, description: 'Refusal rate 0–1.' })
  refusalRate: number;
}

export class SellerKpis {
  @ApiProperty({ format: 'uuid' })
  sellerId: string;

  @ApiProperty({ example: 320 })
  totalOrders: number;

  @ApiProperty({ example: 268 })
  acceptedOrders: number;

  @ApiProperty({ example: 52 })
  refusedOrders: number;

  @ApiProperty({
    example: 18240.5,
    description: 'Value of orders that completed instead of being refused (TND).',
  })
  savedFromAcceptedOrders: number;

  @ApiProperty({
    example: 780.0,
    description: 'Round-trip delivery fees covered by deposits on refused orders (TND).',
  })
  feesCoveredByDeposits: number;

  @ApiProperty({ type: [ZoneRefusalStat] })
  refusalByZone: ZoneRefusalStat[];
}
