import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { GravvEventType } from '../../../common/enums';

/**
 * Normalised Gravv webhook envelope. The raw provider payload may be richer;
 * we validate only the fields we act on. Signature verification happens in the
 * controller against the raw body before this DTO is trusted.
 */
export class GravvWebhookDto {
  @ApiProperty({ enum: GravvEventType })
  @IsEnum(GravvEventType)
  event: GravvEventType;

  @ApiProperty({ example: 'pay_abc123', description: 'Gravv payment id.' })
  @IsString()
  paymentId: string;

  @ApiPropertyOptional({
    description: 'Provider metadata; expected to echo back our orderId.',
    example: { orderId: 'a1b2c3d4-...' },
  })
  @IsOptional()
  @IsObject()
  metadata?: { orderId?: string; [k: string]: unknown };
}
