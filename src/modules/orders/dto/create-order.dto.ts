import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Channel } from '../../../common/enums';
import { OrderItemDto } from './order-item.dto';

/**
 * Payload from the Seller Dashboard (authenticated) to open a new order.
 * The chat-webhook variant is CreateChatOrderDto.
 */
export class CreateOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId: string;

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
