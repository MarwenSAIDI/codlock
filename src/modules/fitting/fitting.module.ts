import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { FittingService } from './fitting.service';
import { FittingController } from './fitting.controller';

@Module({
  imports: [ProductsModule],
  controllers: [FittingController],
  providers: [FittingService],
  exports: [FittingService],
})
export class FittingModule {}
