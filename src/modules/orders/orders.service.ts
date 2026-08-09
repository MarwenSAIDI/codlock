import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { FirebaseService } from '../../database/firebase/firebase.service';
import { CustomersService } from '../customers/customers.service';
import { RiskService } from '../risk/risk.service';
import { PaymentsService } from '../payments/payments.service';
import { ProductsService } from '../products/products.service';
import {
  Channel,
  DepositStatus,
  OrderOutcome,
  OrderStatus,
  ORDER_TRANSITIONS,
} from '../../common/enums';
import {
  Paginated,
  PaginationQueryDto,
  pageRange,
  paginated,
} from '../../common/dto/pagination.dto';
import { InvalidStateTransitionException } from '../../common/exceptions/invalid-state-transition.exception';
import { Order } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateChatOrderDto } from './dto/create-chat-order.dto';
import { OrderItemDto } from './dto/order-item.dto';
import { OrderItemDetails } from './entities/order.entity';

const TABLE = 'orders';

/** Result of ingesting a chat order — a replay yields `duplicate: true`. */
export interface ChatOrderResult {
  duplicate: boolean;
  order: Order | null;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly chatMaxSkewSeconds: number;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly firebase: FirebaseService,
    private readonly customers: CustomersService,
    private readonly products: ProductsService,
    private readonly risk: RiskService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {
    this.chatMaxSkewSeconds =
      this.config.get<number>('social.maxSkewSeconds') ?? 300;
  }

  // ── Reads ──────────────────────────────────────────────────

  async findAllBySeller(
    sellerId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<Order>> {
    const { page, limit } = pagination;
    const [from, to] = pageRange(page, limit);
    const result = await this.supabase
      .table(TABLE)
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .range(from, to);
    const items = this.supabase.unwrap<Order[]>(result) ?? [];
    return paginated(items, result.count ?? items.length, page, limit);
  }

  async findOneForSeller(sellerId: string, id: string): Promise<Order> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .eq('seller_id', sellerId)
      .maybeSingle();
    const order = this.supabase.unwrap<Order | null>(result);
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  // ── Creation ───────────────────────────────────────────────

  /** Dashboard-originated order (customer already exists). */
  async create(sellerId: string, dto: CreateOrderDto): Promise<Order> {
    await this.customers.findOneForSeller(sellerId, dto.customerId);
    const items = await this.buildCatalogItems(sellerId, dto.items);
    return this.insertDraft(sellerId, dto.customerId, dto.channel, items);
  }

  /**
   * Chat-webhook-originated order. Signature is already verified by the guard;
   * here we add replay protection (a freshness window plus event-id dedup via
   * the webhook_events ledger) and then resolve/create the customer by phone
   * and open a DRAFT order. Module 2 entry point.
   *
   * A replayed event returns `{ duplicate: true }` without creating an order.
   * If order creation fails after the event was recorded, the event id is
   * released so a genuine retry can succeed.
   */
  async createFromChat(dto: CreateChatOrderDto): Promise<ChatOrderResult> {
    const ledger = await this.supabase.client.rpc('record_chat_webhook_event', {
      p_event_id: dto.eventId,
      p_sent_at: dto.sentAt,
      p_max_skew_seconds: this.chatMaxSkewSeconds,
    });
    if (ledger.error) {
      throw new BadRequestException(ledger.error.message);
    }
    const { fresh, duplicate } = ledger.data as {
      fresh: boolean;
      duplicate: boolean;
    };

    if (!fresh) {
      throw new UnauthorizedException(
        'Webhook timestamp is outside the accepted window',
      );
    }
    if (duplicate) {
      this.logger.warn(`Chat event ${dto.eventId} replayed — ignored.`);
      return { duplicate: true, order: null };
    }

    try {
      const customer = await this.customers.upsertByPhone(dto.sellerId, {
        phone: dto.customerPhone,
        name: dto.customerName,
        zone: dto.zone,
      });
      const items = await this.buildCatalogItems(dto.sellerId, dto.items);
      const order = await this.insertDraft(
        dto.sellerId,
        customer.id,
        dto.channel,
        items,
      );
      return { duplicate: false, order };
    } catch (err) {
      // Roll the ledger entry back so this event id is not permanently burned.
      await this.supabase.client
        .rpc('release_chat_webhook_event', { p_event_id: dto.eventId })
        .then(undefined, () => undefined);
      throw err;
    }
  }

  private async insertDraft(
    sellerId: string,
    customerId: string,
    channel: Channel,
    items: OrderItemDetails[],
  ): Promise<Order> {
    const total = this.round2(
      items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
    );

    const result = await this.supabase
      .table(TABLE)
      .insert({
        seller_id: sellerId,
        customer_id: customerId,
        channel,
        item_details: items,
        status: OrderStatus.DRAFT,
        total_price: total,
        currency: 'TND',
        deposit_status: DepositStatus.NONE,
        outcome: OrderOutcome.PENDING,
      })
      .select()
      .single();

    const order = this.supabase.unwrap<Order>(result);
    void this.firebase.logEvent('order_events', {
      type: 'ORDER_CREATED',
      orderId: order.id,
      channel,
      total,
    });
    this.logger.log(`Order ${order.id} created (DRAFT, total=${total} TND)`);
    return order;
  }

  // ── Lifecycle orchestration ────────────────────────────────

  /**
   * Module 4 — run the risk engine and persist the deposit terms.
   * Moves DRAFT/PREVIEW_GENERATED → RISK_EVALUATED.
   */
  async evaluateRisk(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    if (
      ![OrderStatus.DRAFT, OrderStatus.PREVIEW_GENERATED].includes(order.status)
    ) {
      throw new InvalidStateTransitionException(
        order.status,
        OrderStatus.RISK_EVALUATED,
      );
    }
    const result = await this.risk.evaluate(sellerId, {
      customerId: order.customer_id,
      orderValue: order.total_price,
      channel: order.channel,
    });

    return this.persistTransition(order, OrderStatus.RISK_EVALUATED, {
      risk_score: result.score,
      deposit_rate: result.depositRate,
      deposit_amount: result.depositAmount,
    });
  }

  /**
   * Module 5 — if a deposit is required, ask Gravv (via the Payment Agent)
   * for a payment link and move to DEPOSIT_PENDING. If the deposit is 0
   * (trusted buyer), skip straight to SHIPPED-eligible by marking it paid.
   */
  async requestDeposit(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);

    // Already carries a provider link — hand the same one back.
    if (order.status === OrderStatus.DEPOSIT_PENDING && order.payment_id) {
      return order;
    }

    // A DEPOSIT_PENDING order with no payment_id never got its link persisted:
    // either the provider call failed, or it succeeded and the follow-up write
    // lost a version race — leaving a live payment the webhook cannot match.
    // The idempotency key is derived from the order id, so asking again
    // returns the same payment instead of double-charging. Resuming is
    // therefore always safe and is the only way such an order gets unstuck.
    const resumable =
      order.status === OrderStatus.DEPOSIT_PENDING &&
      order.deposit_status !== DepositStatus.PAID;

    if (order.status !== OrderStatus.RISK_EVALUATED && !resumable) {
      throw new BadRequestException(
        `Order is not eligible for a deposit request (is ${order.status})`,
      );
    }

    if (!order.deposit_amount || order.deposit_amount <= 0) {
      if (order.status !== OrderStatus.RISK_EVALUATED) {
        throw new BadRequestException(
          'Order is awaiting a deposit but carries no deposit amount',
        );
      }
      this.logger.log(`Order ${id} deposit is 0 — trusted buyer, no charge.`);
      return this.persistTransition(order, OrderStatus.READY_TO_SHIP, {
        deposit_status: DepositStatus.PAID,
      });
    }

    const reserved = await this.persistTransition(
      order,
      OrderStatus.DEPOSIT_PENDING,
      { deposit_status: DepositStatus.PENDING },
    );

    try {
      const link = await this.payments.createDepositLink(
        reserved,
        `deposit:${reserved.id}`,
      );
      return this.persistTransition(reserved, OrderStatus.DEPOSIT_PENDING, {
        payment_id: link.paymentId,
        payment_url: link.paymentUrl,
      });
    } catch (error) {
      await this.persistTransition(reserved, OrderStatus.DEPOSIT_PENDING, {
        deposit_status: DepositStatus.FAILED,
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Cancel an order abandoned before fulfilment (P1). Allowed only from the
   * pre-payment states; a paid, ready, or shipped order cannot be cancelled
   * through this path. Idempotent — re-cancelling returns the order unchanged.
   *
   * No Gravv call is made: if a deposit link was issued but unpaid it simply
   * stops being collectable, so its status is moved to EXPIRED locally.
   */
  async cancel(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    if (order.status === OrderStatus.CANCELLED) return order;

    const cancellable = [
      OrderStatus.DRAFT,
      OrderStatus.PREVIEW_GENERATED,
      OrderStatus.RISK_EVALUATED,
      OrderStatus.DEPOSIT_PENDING,
    ];
    if (!cancellable.includes(order.status)) {
      throw new BadRequestException(
        `Order cannot be cancelled (is ${order.status})`,
      );
    }

    const extra =
      order.deposit_status === DepositStatus.PENDING
        ? { deposit_status: DepositStatus.EXPIRED }
        : {};
    return this.persistTransition(order, OrderStatus.CANCELLED, extra);
  }

  async markReadyToShip(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    if (
      order.status !== OrderStatus.DEPOSIT_PAID ||
      order.deposit_status !== DepositStatus.PAID
    ) {
      throw new BadRequestException(
        'A paid deposit is required before readiness',
      );
    }
    return this.persistTransition(order, OrderStatus.READY_TO_SHIP);
  }

  async markShipped(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    return this.persistTransition(order, OrderStatus.SHIPPED);
  }

  async markPreviewGenerated(sellerId: string, id: string): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    if (order.status === OrderStatus.PREVIEW_GENERATED) return order;
    if (order.status !== OrderStatus.DRAFT) return order;
    return this.persistTransition(order, OrderStatus.PREVIEW_GENERATED);
  }

  /**
   * Final delivery outcome. Records the result on the order AND updates the
   * customer's aggregate history so future risk scoring reflects it.
   */
  async recordOutcome(
    sellerId: string,
    id: string,
    outcome: OrderOutcome,
  ): Promise<Order> {
    const order = await this.findOneForSeller(sellerId, id);
    if (
      order.outcome === outcome &&
      [OrderStatus.ACCEPTED, OrderStatus.REFUSED].includes(order.status)
    ) {
      return order;
    }
    if (order.status !== OrderStatus.SHIPPED) {
      const target =
        outcome === OrderOutcome.ACCEPTED
          ? OrderStatus.ACCEPTED
          : OrderStatus.REFUSED;
      throw new InvalidStateTransitionException(order.status, target);
    }

    const result = await this.supabase.client.rpc('record_order_outcome', {
      p_order_id: id,
      p_seller_id: sellerId,
      p_outcome: outcome,
    });
    if (result.error) {
      throw new ConflictException(result.error.message);
    }
    const updated = result.data as unknown as Order;
    void this.firebase.logEvent('order_events', {
      type: 'OUTCOME_RECORDED',
      orderId: id,
      outcome,
      depositCoveredFees: outcome === OrderOutcome.REFUSED,
    });
    return updated;
  }

  // ── Internal ───────────────────────────────────────────────

  /**
   * Validates the state-machine edge, then applies the update. `extra` fields
   * are written alongside the status change in a single row update.
   */
  private async persistTransition(
    order: Order,
    to: OrderStatus,
    extra: Partial<Order> = {},
  ): Promise<Order> {
    if (order.status !== to) {
      const allowed = ORDER_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(to)) {
        throw new InvalidStateTransitionException(order.status, to);
      }
    }

    const result = await this.supabase
      .table(TABLE)
      .update({
        ...extra,
        status: to,
        version: order.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('seller_id', order.seller_id)
      .eq('status', order.status)
      .eq('version', order.version)
      .select()
      .maybeSingle();

    if (result.error) this.supabase.unwrap<Order>(result);
    if (!result.data) {
      throw new ConflictException(
        `Order ${order.id} changed while this operation was running`,
      );
    }
    const updated = result.data as unknown as Order;
    this.logger.log(`Order ${order.id}: ${order.status} → ${to}`);
    return updated;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private async buildCatalogItems(
    sellerId: string,
    requested: OrderItemDto[],
  ): Promise<OrderItemDetails[]> {
    const products = await this.products.findManyForSeller(
      sellerId,
      requested.map((item) => item.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    return requested.map((item) => {
      const product = byId.get(item.productId);
      if (!product) {
        throw new NotFoundException(`Product ${item.productId} not found`);
      }
      if (item.size && !product.sizes.includes(item.size)) {
        throw new BadRequestException(
          `Size ${item.size} is not available for product ${product.id}`,
        );
      }
      if (item.color && !product.colors.includes(item.color)) {
        throw new BadRequestException(
          `Color ${item.color} is not available for product ${product.id}`,
        );
      }
      return {
        productId: product.id,
        title: product.title,
        size: item.size ?? null,
        color: item.color ?? null,
        quantity: item.quantity,
        unitPrice: Number(product.price),
      };
    });
  }
}
