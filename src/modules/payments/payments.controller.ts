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
import { PaymentsService } from './payments.service';
import { GravvWebhookDto } from './dto/gravv-webhook.dto';

/**
 * Inbound Gravv payment webhooks. Public route secured by HMAC signature
 * verification against the raw request body (see main.ts rawBody capture).
 */
@ApiExcludeController()
@Public()
@Controller('payments/gravv')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  @Post('webhook')
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-gravv-signature') signature: string,
    @Body() dto: GravvWebhookDto,
  ) {
    const secret = this.config.get<string>('gravv.webhookSecret');
    if (!secret) {
      throw new BadRequestException('Gravv webhook secret not configured');
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    if (!verifyHmacSignature(raw, signature, secret)) {
      throw new UnauthorizedException('Invalid Gravv webhook signature');
    }

    return this.payments.processWebhook(dto);
  }
}
