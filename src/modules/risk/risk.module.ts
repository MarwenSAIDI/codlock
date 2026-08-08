import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';

@Module({
  imports: [CustomersModule],
  controllers: [RiskController],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
