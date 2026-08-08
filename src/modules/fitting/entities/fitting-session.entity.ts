import { ApiProperty } from '@nestjs/swagger';

/** Supabase table: `fitting_sessions`. */
export class FittingSession {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  order_id: string | null;

  @ApiProperty({ format: 'uuid' })
  customer_id: string;

  @ApiProperty({ format: 'uuid' })
  product_id: string;

  @ApiProperty({ example: 'https://cdn.codlock.tn/u/photo.jpg' })
  original_photo_url: string;

  @ApiProperty({ example: 'https://cdn.codlock.tn/preview/abc.jpg', nullable: true })
  preview_photo_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;
}
