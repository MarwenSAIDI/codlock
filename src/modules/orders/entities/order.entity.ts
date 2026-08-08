import { ApiProperty } from '@nestjs/swagger';
import {
  Channel,
  DepositStatus,
  OrderOutcome,
  OrderStatus,
} from '../../../common/enums';

/** Structured item extraction from the Darja/English NLP chat parser. */
export class OrderItemDetails {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ example: 'Oversized Cotton Tee' })
  title: string;

  @ApiProperty({ example: 'M', nullable: true })
  size: string | null;

  @ApiProperty({ example: 'black', nullable: true })
  color: string | null;

  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiProperty({ example: 79.9 })
  unitPrice: number;
}

/** Supabase table: `orders`. */
export class Order {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  customer_id: string;

  @ApiProperty({ format: 'uuid' })
  seller_id: string;

  @ApiProperty({ enum: Channel })
  channel: Channel;

  @ApiProperty({ type: [OrderItemDetails], description: 'JSON column.' })
  item_details: OrderItemDetails[];

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ example: 159.8 })
  total_price: number;

  @ApiProperty({ example: 62, nullable: true })
  risk_score: number | null;

  @ApiProperty({ example: 0.1, nullable: true })
  deposit_rate: number | null;

  @ApiProperty({ example: 15.98, nullable: true })
  deposit_amount: number | null;

  @ApiProperty({ enum: DepositStatus })
  deposit_status: DepositStatus;

  @ApiProperty({ example: 'pay_abc123', nullable: true })
  payment_id: string | null;

  @ApiProperty({ example: 'https://pay.gravv.fi/l/abc', nullable: true })
  payment_url: string | null;

  @ApiProperty({ enum: OrderOutcome })
  outcome: OrderOutcome;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
