import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class GeneratePreviewDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Customer requesting the try-on.',
  })
  @IsUUID()
  customerId: string;

  @ApiProperty({ format: 'uuid', description: 'Catalog product to fit.' })
  @IsUUID()
  productId: string;

  @ApiProperty({
    example: 'https://cdn.codlock.tn/u/customer-photo.jpg',
    description: 'Public URL of the customer photo to render the try-on on.',
  })
  @IsUrl({ protocols: ['https'], require_protocol: true })
  customerPhotoUrl: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Link the session to an order.',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;

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
}
