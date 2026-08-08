import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { OrderOutcome } from '../../common/enums';
import { SellerKpis, ZoneRefusalStat } from './dto/seller-kpis.dto';

/**
 * Module 6 — Seller & Risk Analytics.
 *
 * Aggregates order + customer data into the KPIs the dashboard surfaces:
 * money saved by completed orders, delivery fees recouped via deposits on
 * refusals, and refusal distribution per delivery zone.
 *
 * Reads join `orders` with `customers` (for the zone). Kept as an in-memory
 * fold for clarity; move to a Postgres view / RPC once volume grows.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly supabase: SupabaseService) {}

  async sellerKpis(sellerId: string): Promise<SellerKpis> {
    const result = await this.supabase
      .table('orders')
      .select(
        'id, outcome, total_price, deposit_amount, customer:customers(zone)',
      )
      .eq('seller_id', sellerId);

    // supabase-js infers embedded relations as arrays even for many-to-one, so
    // accept either shape and normalise the zone below.
    type Related = { zone: string | null } | { zone: string | null }[] | null;
    type Row = {
      outcome: OrderOutcome;
      total_price: number;
      deposit_amount: number | null;
      customer: Related;
    };
    const rows = (this.supabase.unwrap<Row[]>(result as never) ?? []) as Row[];

    const zoneOf = (customer: Related): string => {
      const rel = Array.isArray(customer) ? customer[0] : customer;
      return rel?.zone ?? 'UNKNOWN';
    };

    let acceptedOrders = 0;
    let refusedOrders = 0;
    let savedFromAcceptedOrders = 0;
    let feesCoveredByDeposits = 0;
    const zoneMap = new Map<string, { total: number; refused: number }>();

    for (const row of rows) {
      const zone = zoneOf(row.customer);
      const z = zoneMap.get(zone) ?? { total: 0, refused: 0 };
      z.total += 1;

      if (row.outcome === OrderOutcome.ACCEPTED) {
        acceptedOrders += 1;
        savedFromAcceptedOrders += row.total_price ?? 0;
      } else if (row.outcome === OrderOutcome.REFUSED) {
        refusedOrders += 1;
        feesCoveredByDeposits += row.deposit_amount ?? 0;
        z.refused += 1;
      }
      zoneMap.set(zone, z);
    }

    const refusalByZone: ZoneRefusalStat[] = [...zoneMap.entries()]
      .map(([zone, s]) => ({
        zone,
        totalOrders: s.total,
        refusedOrders: s.refused,
        refusalRate: s.total ? this.round3(s.refused / s.total) : 0,
      }))
      .sort((a, b) => b.refusalRate - a.refusalRate);

    return {
      sellerId,
      totalOrders: rows.length,
      acceptedOrders,
      refusedOrders,
      savedFromAcceptedOrders: this.round2(savedFromAcceptedOrders),
      feesCoveredByDeposits: this.round2(feesCoveredByDeposits),
      refusalByZone,
    };
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }
}
