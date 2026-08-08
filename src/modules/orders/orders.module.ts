import { forwardRef, Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RiskModule } from '../risk/risk.module';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersWebhookController } from './orders-webhook.controller';

@Module({
  imports: [
    CustomersModule,
    RiskModule,
    forwardRef(() => PaymentsModule), // Orders ⇄ Payments (deposit link ↔ webhook)
  ],
  controllers: [OrdersController, OrdersWebhookController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
