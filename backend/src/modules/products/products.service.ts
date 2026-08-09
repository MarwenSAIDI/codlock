import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import {
  Paginated,
  PaginationQueryDto,
  pageRange,
  paginated,
} from '../../common/dto/pagination.dto';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

const TABLE = 'products';

@Injectable()
export class ProductsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAllBySeller(
    sellerId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<Product>> {
    const { page, limit } = pagination;
    const [from, to] = pageRange(page, limit);
    const result = await this.supabase
      .table(TABLE)
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('updated_at', { ascending: false })
      .range(from, to);
    const items = this.supabase.unwrap<Product[]>(result) ?? [];
    return paginated(items, result.count ?? items.length, page, limit);
  }

  async findOneForSeller(sellerId: string, id: string): Promise<Product> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .eq('seller_id', sellerId)
      .maybeSingle();
    const product = this.supabase.unwrap<Product | null>(result);
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  async findManyForSeller(sellerId: string, ids: string[]): Promise<Product[]> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .in('id', [...new Set(ids)]);
    return this.supabase.unwrap<Product[]>(result) ?? [];
  }

  async create(sellerId: string, dto: CreateProductDto): Promise<Product> {
    const result = await this.supabase
      .table(TABLE)
      .insert({ seller_id: sellerId, ...dto })
      .select()
      .single();
    return this.supabase.unwrap<Product>(result);
  }

  async update(
    sellerId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<Product> {
    await this.findOneForSeller(sellerId, id);
    const result = await this.supabase
      .table(TABLE)
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('seller_id', sellerId)
      .select()
      .single();
    return this.supabase.unwrap<Product>(result);
  }

  async remove(sellerId: string, id: string): Promise<{ id: string }> {
    await this.findOneForSeller(sellerId, id);
    const result = await this.supabase
      .table(TABLE)
      .delete()
      .eq('id', id)
      .eq('seller_id', sellerId);
    this.supabase.unwrap(result);
    return { id };
  }
}
