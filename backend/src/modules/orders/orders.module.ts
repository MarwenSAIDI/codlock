import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RiskModule } from '../risk/risk.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProductsModule } from '../products/products.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersWebhookController } from './orders-webhook.controller';

@Module({
  imports: [CustomersModule, ProductsModule, RiskModule, PaymentsModule],
  controllers: [OrdersController, OrdersWebhookController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
