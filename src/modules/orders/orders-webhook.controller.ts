import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { verifyHmacSignature } from '../../common/utils/signature.util';
import { OrdersService } from './orders.service';
import { CreateChatOrderDto } from './dto/create-chat-order.dto';

/**
 * Inbound webhook from the WhatsApp/Instagram NLP chat parsers. Public route,
 * protected by HMAC signature verification rather than JWT.
 *
 * Requires the raw-body capture configured in main.ts so the signature is
 * checked against the exact received bytes.
 */
@ApiExcludeController()
@Public()
@Controller('webhooks/chat')
export class OrdersWebhookController {
  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  @Post('order')
  async ingestOrder(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-signature') signature: string,
    @Body() dto: CreateChatOrderDto,
  ) {
    const secret = this.config.get<string>('social.webhookSecret');
    if (!secret) {
      throw new BadRequestException('Social webhook secret not configured');
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    if (!verifyHmacSignature(raw, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const order = await this.orders.createFromChat(dto);
    return { orderId: order.id, status: order.status };
  }
}
