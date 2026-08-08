import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'TSHIRT-BLK-001' })
  @IsString()
  @MaxLength(64)
  sku: string;

  @ApiProperty({ example: 'Oversized Cotton Tee' })
  @IsString()
  @MaxLength(160)
  title: string;

  @ApiProperty({ example: 79.9, description: 'Unit price in TND.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price: number;

  @ApiProperty({ example: ['S', 'M', 'L', 'XL'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  sizes: string[];

  @ApiProperty({ example: ['black', 'white'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  colors: string[];

  @ApiPropertyOptional({ example: 'https://cdn.codlock.tn/p/tshirt-blk.jpg' })
  @IsOptional()
  @IsUrl()
  image_url?: string;

  @ApiPropertyOptional({ example: 'apparel' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}
