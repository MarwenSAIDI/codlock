import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { FittingService } from './fitting.service';
import { FittingController } from './fitting.controller';

@Module({
  imports: [ProductsModule, CustomersModule, OrdersModule],
  controllers: [FittingController],
  providers: [FittingService],
  exports: [FittingService],
})
export class FittingModule {}
