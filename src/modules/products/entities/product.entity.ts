import { ApiProperty } from '@nestjs/swagger';

/** Supabase table: `products` (the seller's catalog / SKUs). */
export class Product {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  seller_id: string;

  @ApiProperty({ example: 'TSHIRT-BLK-001' })
  sku: string;

  @ApiProperty({ example: 'Oversized Cotton Tee' })
  title: string;

  @ApiProperty({ example: 79.9, description: 'Unit price in TND.' })
  price: number;

  @ApiProperty({ example: ['S', 'M', 'L', 'XL'], type: [String] })
  sizes: string[];

  @ApiProperty({ example: ['black', 'white'], type: [String] })
  colors: string[];

  @ApiProperty({
    example: 'https://cdn.codlock.tn/p/tshirt-blk.jpg',
    nullable: true,
  })
  image_url: string | null;

  @ApiProperty({ example: 'apparel', nullable: true })
  category: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
