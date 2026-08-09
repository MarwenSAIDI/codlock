import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { ProductsService } from '../products/products.service';
import { CustomersService } from '../customers/customers.service';
import { OrdersService } from '../orders/orders.service';
import { GeneratePreviewDto } from './dto/generate-preview.dto';
import { FittingSession } from './entities/fitting-session.entity';

const TABLE = 'fitting_sessions';

/**
 * Module 3 — Virtual Fitting Room.
 * Forwards a (customer photo + product) pair to the Fitting Agent via the
 * Orchestrator, then persists the rendered preview URL as a session row.
 */
@Injectable()
export class FittingService {
  private readonly logger = new Logger(FittingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly orchestrator: OrchestratorService,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
  ) {}

  async generatePreview(
    sellerId: string,
    dto: GeneratePreviewDto,
  ): Promise<FittingSession> {
    await this.customers.findOneForSeller(sellerId, dto.customerId);
    await this.products.findOneForSeller(sellerId, dto.productId);

    if (dto.orderId) {
      const order = await this.orders.findOneForSeller(sellerId, dto.orderId);
      if (order.customer_id !== dto.customerId) {
        throw new BadRequestException(
          'Order and fitting customer do not match',
        );
      }
      if (
        !order.item_details.some((item) => item.productId === dto.productId)
      ) {
        throw new BadRequestException('Product is not part of the order');
      }
    }

    const preview = await this.orchestrator.generatePreview({
      orderId: dto.orderId,
      customerId: dto.customerId,
      productId: dto.productId,
      customerPhotoUrl: dto.customerPhotoUrl,
      size: dto.size,
      color: dto.color,
    });

    const result = await this.supabase
      .table(TABLE)
      .insert({
        order_id: dto.orderId ?? null,
        customer_id: dto.customerId,
        product_id: dto.productId,
        original_photo_url: dto.customerPhotoUrl,
        preview_photo_url: preview.previewPhotoUrl,
      })
      .select()
      .single();

    const session = this.supabase.unwrap<FittingSession>(result);
    if (dto.orderId) {
      await this.orders.markPreviewGenerated(sellerId, dto.orderId);
    }
    this.logger.log(
      `Fitting session ${session.id} created for product ${dto.productId}`,
    );
    return session;
  }

  async findByOrder(
    sellerId: string,
    orderId: string,
  ): Promise<FittingSession[]> {
    await this.orders.findOneForSeller(sellerId, orderId);
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });
    return this.supabase.unwrap<FittingSession[]>(result) ?? [];
  }
}
