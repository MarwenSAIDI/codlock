import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookSignature } from '../../common/decorators/webhook-signature.decorator';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { OrdersService } from './orders.service';
import { CreateChatOrderDto } from './dto/create-chat-order.dto';

/**
 * Inbound webhook from the WhatsApp/Instagram NLP chat parsers. Public route
 * (no JWT) authenticated by WebhookSignatureGuard, which verifies the HMAC over
 * the raw body BEFORE the validation pipe runs. Replay protection (freshness
 * window + event-id dedup) is applied in OrdersService.createFromChat.
 */
@ApiExcludeController()
@Public()
@UseGuards(WebhookSignatureGuard)
@WebhookSignature({
  header: 'x-signature',
  secretKey: 'social.webhookSecret',
})
@Controller('webhooks/chat')
export class OrdersWebhookController {
  constructor(private readonly orders: OrdersService) {}

  @Post('order')
  async ingestOrder(@Body() dto: CreateChatOrderDto) {
    const result = await this.orders.createFromChat(dto);
    if (result.duplicate || !result.order) {
      return { duplicate: true };
    }
    return { orderId: result.order.id, status: result.order.status };
  }
}
