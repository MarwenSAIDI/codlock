import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedSeller,
  CurrentSeller,
} from '../../common/decorators/current-seller.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated seller's orders" })
  findAll(@CurrentSeller() seller: AuthenticatedSeller) {
    return this.orders.findAllBySeller(seller.sellerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order by id' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an order (DRAFT)' })
  create(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.create(seller.sellerId, dto);
  }

  @Post(':id/evaluate-risk')
  @ApiOperation({
    summary: 'Run the risk engine and attach deposit terms',
    description: 'DRAFT / PREVIEW_GENERATED → RISK_EVALUATED.',
  })
  evaluateRisk(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.evaluateRisk(id);
  }

  @Post(':id/request-deposit')
  @ApiOperation({
    summary: 'Generate the Gravv deposit link (or skip for trusted buyers)',
    description: 'RISK_EVALUATED → DEPOSIT_PENDING (or marks paid if deposit is 0).',
  })
  requestDeposit(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.requestDeposit(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Apply a manual lifecycle transition (e.g. mark SHIPPED)',
  })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.transition(id, dto.status);
  }

  @Post(':id/outcome')
  @ApiOperation({
    summary: 'Record the final delivery outcome (ACCEPTED / REFUSED)',
    description: 'Updates customer risk history for future scoring.',
  })
  recordOutcome(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordOutcomeDto,
  ) {
    return this.orders.recordOutcome(id, dto.outcome);
  }
}
