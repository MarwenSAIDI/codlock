import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { RiskTier } from '../../common/enums';
import {
  Paginated,
  PaginationQueryDto,
  pageRange,
  paginated,
} from '../../common/dto/pagination.dto';
import { Customer } from './entities/customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

const TABLE = 'customers';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async findAllBySeller(
    sellerId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<Customer>> {
    const { page, limit } = pagination;
    const [from, to] = pageRange(page, limit);
    const result = await this.supabase
      .table(TABLE)
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('updated_at', { ascending: false })
      .range(from, to);
    const items = this.supabase.unwrap<Customer[]>(result) ?? [];
    return paginated(items, result.count ?? items.length, page, limit);
  }

  async findOneForSeller(sellerId: string, id: string): Promise<Customer> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .eq('seller_id', sellerId)
      .maybeSingle();
    const customer = this.supabase.unwrap<Customer | null>(result);
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    return customer;
  }

  /** Look up by phone; used by the webhook path to resolve chat orders. */
  async findByPhone(sellerId: string, phone: string): Promise<Customer | null> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .eq('phone', phone)
      .maybeSingle();
    return this.supabase.unwrap<Customer | null>(result);
  }

  async create(sellerId: string, dto: CreateCustomerDto): Promise<Customer> {
    const result = await this.supabase
      .table(TABLE)
      .insert({
        seller_id: sellerId,
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
  async upsertByPhone(
    sellerId: string,
    dto: CreateCustomerDto,
  ): Promise<Customer> {
    const values: Record<string, unknown> = {
      seller_id: sellerId,
      phone: dto.phone,
    };
    if (dto.name !== undefined) values.name = dto.name;
    if (dto.zone !== undefined) values.zone = dto.zone;

    const result = await this.supabase
      .table(TABLE)
      .upsert(values, { onConflict: 'seller_id,phone' })
      .select()
      .single();
    return this.supabase.unwrap<Customer>(result);
  }

  async update(
    sellerId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    await this.findOneForSeller(sellerId, id);
    const result = await this.supabase
      .table(TABLE)
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('seller_id', sellerId)
      .select()
      .single();
    return this.supabase.unwrap<Customer>(result);
  }
}
