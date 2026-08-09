import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedSeller,
  CurrentSeller,
} from '../../common/decorators/current-seller.decorator';
import { AnalyticsService } from './analytics.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('kpis')
  @ApiOperation({
    summary: 'Seller KPIs',
    description:
      'Money saved by completed orders, delivery fees recouped via deposits, and refusal distribution per zone.',
  })
  kpis(@CurrentSeller() seller: AuthenticatedSeller) {
    return this.analytics.sellerKpis(seller.sellerId);
  }
}
