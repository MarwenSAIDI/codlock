import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookSignature } from '../../common/decorators/webhook-signature.decorator';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { PaymentsService } from './payments.service';
import { GravvWebhookDto } from './dto/gravv-webhook.dto';

/**
 * Inbound Gravv payment webhooks. Public route (no JWT) authenticated by the
 * WebhookSignatureGuard, which verifies the HMAC over the raw body BEFORE the
 * validation pipe parses the DTO.
 */
@ApiExcludeController()
@Public()
@UseGuards(WebhookSignatureGuard)
@WebhookSignature({
  header: 'x-gravv-signature',
  secretKey: 'gravv.webhookSecret',
})
@Controller('payments/gravv')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  async webhook(@Body() dto: GravvWebhookDto) {
    return this.payments.processWebhook(dto);
  }
}
