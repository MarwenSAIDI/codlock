import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { OrdersService } from '../orders/orders.service';
import { Order } from '../orders/entities/order.entity';
import { CreatePaymentLinkResponse } from '../orchestrator/dto/orchestrator-contracts';
import { DepositStatus, GravvEventType } from '../../common/enums';
import { GravvWebhookDto } from './dto/gravv-webhook.dto';

/**
 * Module 5 — Gravv Payment Gateway integration.
 *
 * Outbound: requests a deposit payment link through the Orchestrator's
 * Payment Agent (→ gravvfi/mcp).
 * Inbound: processes verified Gravv webhooks and drives the order's deposit
 * state via OrdersService.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  /** Create a deposit payment link for an order that requires one. */
  async createDepositLink(order: Order): Promise<CreatePaymentLinkResponse> {
    const link = await this.orchestrator.createPaymentLink({
      orderId: order.id,
      customerId: order.customer_id,
      amount: order.deposit_amount ?? 0,
      currency: 'TND',
      description: `CODLOCK deposit for order ${order.id}`,
      metadata: { orderId: order.id, sellerId: order.seller_id },
    });
    this.logger.log(
      `Deposit link created for order ${order.id}: ${link.paymentId}`,
    );
    return link;
  }

  /**
   * Handle a signature-verified Gravv webhook. Resolves the target order via
   * the metadata.orderId (preferred) or the payment id, then applies the
   * matching deposit-state transition. Idempotent by design — replaying the
   * same event lands the order in the same state.
   */
  async processWebhook(dto: GravvWebhookDto): Promise<{ orderId: string; applied: string }> {
    const order = await this.resolveOrder(dto);

    switch (dto.event) {
      case GravvEventType.PAYMENT_SUCCEEDED:
        await this.orders.markDepositPaid(order.id);
        return { orderId: order.id, applied: 'DEPOSIT_PAID' };

      case GravvEventType.PAYMENT_FAILED:
        await this.orders.markDepositFailed(order.id, DepositStatus.FAILED);
        return { orderId: order.id, applied: 'DEPOSIT_FAILED' };

      case GravvEventType.PAYMENT_EXPIRED:
        await this.orders.markDepositFailed(order.id, DepositStatus.EXPIRED);
        return { orderId: order.id, applied: 'DEPOSIT_EXPIRED' };

      default:
        this.logger.warn(`Ignoring unhandled Gravv event: ${dto.event}`);
        return { orderId: order.id, applied: 'IGNORED' };
    }
  }

  private async resolveOrder(dto: GravvWebhookDto): Promise<Order> {
    if (dto.metadata?.orderId) {
      return this.orders.findOne(dto.metadata.orderId);
    }
    const byPayment = await this.orders.findByPaymentId(dto.paymentId);
    if (!byPayment) {
      throw new NotFoundException(
        `No order matches Gravv payment ${dto.paymentId}`,
      );
    }
    return byPayment;
  }
}
