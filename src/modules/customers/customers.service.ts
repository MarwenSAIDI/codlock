import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { RiskTier } from '../../common/enums';
import { Customer } from './entities/customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

const TABLE = 'customers';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async findAll(): Promise<Customer[]> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .order('updated_at', { ascending: false });
    return this.supabase.unwrap<Customer[]>(result) ?? [];
  }

  async findOne(id: string): Promise<Customer> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    const customer = this.supabase.unwrap<Customer | null>(result);
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    return customer;
  }

  /** Look up by phone; used by the webhook path to resolve chat orders. */
  async findByPhone(phone: string): Promise<Customer | null> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    return this.supabase.unwrap<Customer | null>(result);
  }

  async create(dto: CreateCustomerDto): Promise<Customer> {
    const result = await this.supabase
      .table(TABLE)
      .insert({
        phone: dto.phone,
        name: dto.name ?? null,
        zone: dto.zone ?? null,
        total_orders: 0,
        successful_orders: 0,
        refused_orders: 0,
        risk_tier: RiskTier.MEDIUM, // unknown history → medium until scored
      })
      .select()
      .single();
    return this.supabase.unwrap<Customer>(result);
  }

  /** Get-or-create by phone — the entry point for chat-originated orders. */
  async upsertByPhone(dto: CreateCustomerDto): Promise<Customer> {
    const existing = await this.findByPhone(dto.phone);
    if (existing) return existing;
    return this.create(dto);
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    await this.findOne(id);
    const result = await this.supabase
      .table(TABLE)
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    return this.supabase.unwrap<Customer>(result);
  }

  /**
   * Atomically record an order outcome against the customer's history.
   * Called by OrdersService when an order reaches ACCEPTED / REFUSED so the
   * risk engine always reads fresh aggregates.
   */
  async recordOutcome(id: string, accepted: boolean): Promise<Customer> {
    const customer = await this.findOne(id);
    const successful_orders =
      customer.successful_orders + (accepted ? 1 : 0);
    const refused_orders = customer.refused_orders + (accepted ? 0 : 1);
    const total_orders = customer.total_orders + 1;

    const result = await this.supabase
      .table(TABLE)
      .update({
        total_orders,
        successful_orders,
        refused_orders,
        risk_tier: this.deriveTier(refused_orders, total_orders),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    return this.supabase.unwrap<Customer>(result);
  }

  /** Simple heuristic tier from historical refusal rate. */
  private deriveTier(refused: number, total: number): RiskTier {
    if (total === 0) return RiskTier.MEDIUM;
    const rate = refused / total;
    if (rate >= 0.4) return RiskTier.HIGH;
    if (rate <= 0.1 && total >= 3) return RiskTier.TRUSTED;
    return RiskTier.MEDIUM;
  }
}
