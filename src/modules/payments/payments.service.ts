import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { CreatePaymentLinkResponse } from '../orchestrator/dto/orchestrator-contracts';
import { Order } from '../orders/entities/order.entity';
import { GravvWebhookDto } from './dto/gravv-webhook.dto';

export interface ProcessedPaymentWebhook {
  orderId: string;
  applied: string;
  duplicate: boolean;
}

/**
 * Gravv payment integration. Payment creation carries an idempotency key;
 * webhook processing is delegated to a PostgreSQL function so event
 * deduplication and the order transition happen in one transaction.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly supabase: SupabaseService,
  ) {}

  async createDepositLink(
    order: Order,
    idempotencyKey: string,
  ): Promise<CreatePaymentLinkResponse> {
    const link = await this.orchestrator.createPaymentLink({
      orderId: order.id,
      customerId: order.customer_id,
      amount: order.deposit_amount ?? 0,
      currency: order.currency,
      idempotencyKey,
      description: `CODLOCK deposit for order ${order.id}`,
      metadata: { orderId: order.id, sellerId: order.seller_id },
    });
    this.logger.log(
      `Deposit link created for order ${order.id}: ${link.paymentId}`,
    );
    return link;
  }

  async processWebhook(dto: GravvWebhookDto): Promise<ProcessedPaymentWebhook> {
    const result = await this.supabase.client.rpc('process_gravv_webhook', {
      p_event_id: dto.eventId,
      p_event_type: dto.event,
      p_payment_id: dto.paymentId,
      p_amount: dto.amount,
      p_currency: dto.currency.toUpperCase(),
    });
    if (result.error) {
      throw new BadRequestException(result.error.message);
    }
    return result.data;
  }
}
