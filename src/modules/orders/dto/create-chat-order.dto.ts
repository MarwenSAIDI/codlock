import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Channel } from '../../../common/enums';
import { OrderItemDto } from './order-item.dto';

/**
 * Structured order-extraction payload emitted by the Darja/English NLP chat
 * parser and delivered via the social webhook. The customer is resolved (or
 * created) by phone rather than by id.
 */
export class CreateChatOrderDto {
  @ApiProperty({
    example: 'chat_evt_a1b2c3',
    description:
      'Unique id for this delivery, used for replay dedup. Part of the ' +
      'signed body.',
  })
  @IsString()
  @MaxLength(160)
  eventId: string;

  @ApiProperty({
    example: '2026-08-10T12:00:00.000Z',
    description:
      'When the parser emitted the event (ISO-8601). Rejected outside the ' +
      'configured freshness window.',
  })
  @IsISO8601()
  sentAt: string;

  @ApiProperty({ example: '+21620123456' })
  @IsPhoneNumber(undefined, {
    message: 'customerPhone must be a valid international number',
  })
  customerPhone: string;

  @ApiPropertyOptional({ example: 'Amine Ben Salah' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @ApiPropertyOptional({ example: 'Sfax' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  zone?: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Seller who owns the conversation.',
  })
  @IsUUID()
  sellerId: string;

  @ApiProperty({ enum: Channel })
  @IsEnum(Channel)
  channel: Channel;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
