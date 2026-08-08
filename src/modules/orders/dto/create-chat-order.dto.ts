import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
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
  @ApiProperty({ example: '+21620123456' })
  @IsPhoneNumber(undefined, { message: 'customerPhone must be a valid international number' })
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

  @ApiProperty({ format: 'uuid', description: 'Seller who owns the conversation.' })
  @IsUUID()
  sellerId: string;

  @ApiProperty({ enum: Channel })
  @IsEnum(Channel)
  channel: Channel;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
