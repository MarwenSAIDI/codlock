import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { FirebaseService } from '../../database/firebase/firebase.service';
import { CustomersService } from '../customers/customers.service';
import { RiskService } from '../risk/risk.service';
import { PaymentsService } from '../payments/payments.service';
import {
  Channel,
  DepositStatus,
  OrderOutcome,
  OrderStatus,
  ORDER_TRANSITIONS,
} from '../../common/enums';
import { InvalidStateTransitionException } from '../../common/exceptions/invalid-state-transition.exception';
import { Order } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateChatOrderDto } from './dto/create-chat-order.dto';
import { OrderItemDto } from './dto/order-item.dto';

const TABLE = 'orders';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly firebase: FirebaseService,
    private readonly customers: CustomersService,
    private readonly risk: RiskService,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────

  async findAllBySeller(sellerId: string): Promise<Order[]> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false });
    return this.supabase.unwrap<Order[]>(result) ?? [];
  }

  async findOne(id: string): Promise<Order> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    const order = this.supabase.unwrap<Order | null>(result);
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async findByPaymentId(paymentId: string): Promise<Order | null> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('payment_id', paymentId)
      .maybeSingle();
    return this.supabase.unwrap<Order | null>(result);
  }

  // ── Creation ───────────────────────────────────────────────

  /** Dashboard-originated order (customer already exists). */
  async create(sellerId: string, dto: CreateOrderDto): Promise<Order> {
    await this.customers.findOne(dto.customerId);
    return this.insertDraft(sellerId, dto.customerId, dto.channel, dto.items);
  }

  /**
   * Chat-webhook-originated order. Resolves/creates the customer by phone,
   * then opens a DRAFT order. Module 2 entry point.
   */
  async createFromChat(dto: CreateChatOrderDto): Promise<Order> {
    const customer = await this.customers.upsertByPhone({
      phone: dto.customerPhone,
      name: dto.customerName,
      zone: dto.zone,
    });
    return this.insertDraft(dto.sellerId, customer.id, dto.channel, dto.items);
  }

  private async insertDraft(
    sellerId: string,
    customerId: string,
    channel: Channel,
    items: OrderItemDto[],
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
  async evaluateRisk(id: string): Promise<Order> {
    const order = await this.findOne(id);
    const result = await this.risk.evaluate({
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
  async requestDeposit(id: string): Promise<Order> {
    const order = await this.findOne(id);
    if (order.status !== OrderStatus.RISK_EVALUATED) {
      throw new BadRequestException(
        `Order must be RISK_EVALUATED before requesting a deposit (is ${order.status})`,
      );
    }

    if (!order.deposit_amount || order.deposit_amount <= 0) {
      this.logger.log(`Order ${id} deposit is 0 — trusted buyer, no charge.`);
      return this.persistTransition(order, OrderStatus.RISK_EVALUATED, {
        deposit_status: DepositStatus.PAID,
      });
    }

    const link = await this.payments.createDepositLink(order);
    return this.persistTransition(order, OrderStatus.DEPOSIT_PENDING, {
      deposit_status: DepositStatus.PENDING,
      payment_id: link.paymentId,
      payment_url: link.paymentUrl,
    });
  }

  /** Called by the Gravv webhook on a successful deposit payment. */
  async markDepositPaid(id: string): Promise<Order> {
    const order = await this.findOne(id);
    void this.firebase.logEvent('order_events', {
      type: 'DEPOSIT_PAID',
      orderId: id,
      amount: order.deposit_amount,
    });
    return this.persistTransition(order, OrderStatus.DEPOSIT_PAID, {
      deposit_status: DepositStatus.PAID,
    });
  }

  /** Called by the Gravv webhook on a failed/expired deposit payment. */
  async markDepositFailed(id: string, status: DepositStatus): Promise<Order> {
    const order = await this.findOne(id);
    // Stay in DEPOSIT_PENDING but flag the payment state for retry/UX.
    return this.persistTransition(order, OrderStatus.DEPOSIT_PENDING, {
      deposit_status: status,
    });
  }

  /** Manual/dashboard transition (e.g. mark SHIPPED). */
  async transition(id: string, to: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    return this.persistTransition(order, to);
  }

  /**
   * Final delivery outcome. Records the result on the order AND updates the
   * customer's aggregate history so future risk scoring reflects it.
   */
  async recordOutcome(id: string, outcome: OrderOutcome): Promise<Order> {
    const order = await this.findOne(id);
    const target =
      outcome === OrderOutcome.ACCEPTED
        ? OrderStatus.ACCEPTED
        : OrderStatus.REFUSED;

    const updated = await this.persistTransition(order, target, { outcome });
    await this.customers.recordOutcome(
      order.customer_id,
      outcome === OrderOutcome.ACCEPTED,
    );
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
      .update({ ...extra, status: to, updated_at: new Date().toISOString() })
      .eq('id', order.id)
      .select()
      .single();

    const updated = this.supabase.unwrap<Order>(result);
    this.logger.log(`Order ${order.id}: ${order.status} → ${to}`);
    return updated;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
