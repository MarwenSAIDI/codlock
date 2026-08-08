import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase/supabase.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { ProductsService } from '../products/products.service';
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
  ) {}

  async generatePreview(dto: GeneratePreviewDto): Promise<FittingSession> {
    // Validate the product exists before spending AI budget on it.
    await this.products.findOne(dto.productId);

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
    this.logger.log(`Fitting session ${session.id} created for product ${dto.productId}`);
    return session;
  }

  async findByOrder(orderId: string): Promise<FittingSession[]> {
    const result = await this.supabase
      .table(TABLE)
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });
    return this.supabase.unwrap<FittingSession[]>(result) ?? [];
  }
}
