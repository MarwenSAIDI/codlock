import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

const TABLE = 'products';

@Injectable()
export class ProductsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAllBySeller(sellerId: string): Promise<Product[]> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .order('updated_at', { ascending: false });
    return this.supabase.unwrap<Product[]>(result) ?? [];
  }

  async findOne(id: string): Promise<Product> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    const product = this.supabase.unwrap<Product | null>(result);
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
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
    const product = await this.findOne(id);
    if (product.seller_id !== sellerId) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const result = await this.supabase
      .table(TABLE)
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    return this.supabase.unwrap<Product>(result);
  }

  async remove(sellerId: string, id: string): Promise<{ id: string }> {
    const product = await this.findOne(id);
    if (product.seller_id !== sellerId) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const result = await this.supabase.table(TABLE).delete().eq('id', id);
    this.supabase.unwrap(result);
    return { id };
  }
}
