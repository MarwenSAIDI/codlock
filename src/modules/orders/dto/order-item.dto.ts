import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 'Oversized Cotton Tee' })
  @IsString()
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional({ example: 'M' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  size?: string;

  @ApiPropertyOptional({ example: 'black' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({ example: 79.9, description: 'Unit price in TND.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  unitPrice: number;
}
