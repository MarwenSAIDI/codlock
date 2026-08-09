import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';
import { Channel } from '../../../common/enums';

export class EvaluateRiskDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId: string;

  @ApiProperty({ example: 149.9, description: 'Order value in TND.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  orderValue: number;

  @ApiPropertyOptional({ enum: Channel })
  @IsOptional()
  @IsEnum(Channel)
  channel?: Channel;

  @ApiPropertyOptional({ example: 'Kairouan', description: 'Delivery zone.' })
  @IsOptional()
  @IsString()
  zone?: string;
}
