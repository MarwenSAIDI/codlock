import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { SellerKpis } from './dto/seller-kpis.dto';

/**
 * Module 6 — Seller & Risk Analytics.
 *
 * Aggregation lives in the `seller_kpis` PostgreSQL function rather than in
 * this service. The previous in-memory fold pulled every order for the seller
 * through PostgREST, which caps result sets at its own row limit — so past
 * roughly a thousand orders the KPIs were quietly computed over a prefix of
 * the data, with no error to say so.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async sellerKpis(sellerId: string): Promise<SellerKpis> {
    const result = await this.supabase.client.rpc('seller_kpis', {
      p_seller_id: sellerId,
    });

    if (result.error) {
      this.logger.error(`seller_kpis failed: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to compute seller KPIs');
    }

    return result.data as SellerKpis;
  }
}
