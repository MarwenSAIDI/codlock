import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedSeller,
  CurrentSeller,
} from '../../common/decorators/current-seller.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: "List the authenticated seller's orders",
    description: 'Paginated, newest first.',
  })
  findAll(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.orders.findAllBySeller(seller.sellerId, pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order by id' })
  findOne(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.findOneForSeller(seller.sellerId, id);
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
  evaluateRisk(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.evaluateRisk(seller.sellerId, id);
  }

  @Post(':id/request-deposit')
  @ApiOperation({
    summary: 'Generate the Gravv deposit link (or skip for trusted buyers)',
    description:
      'RISK_EVALUATED → DEPOSIT_PENDING (or marks paid if deposit is 0).',
  })
  requestDeposit(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.requestDeposit(seller.sellerId, id);
  }

  @Post(':id/ready-to-ship')
  @ApiOperation({ summary: 'Mark a deposit-paid order ready to ship' })
  markReadyToShip(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.markReadyToShip(seller.sellerId, id);
  }

  @Post(':id/ship')
  @ApiOperation({ summary: 'Ship an order that is ready to ship' })
  markShipped(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.markShipped(seller.sellerId, id);
  }

  @Post(':id/outcome')
  @ApiOperation({
    summary: 'Record the final delivery outcome (ACCEPTED / REFUSED)',
    description: 'Updates customer risk history for future scoring.',
  })
  recordOutcome(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordOutcomeDto,
  ) {
    return this.orders.recordOutcome(seller.sellerId, id, dto.outcome);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel an order abandoned before fulfilment',
    description:
      'Allowed from DRAFT / PREVIEW_GENERATED / RISK_EVALUATED / ' +
      'DEPOSIT_PENDING → CANCELLED. Rejected once a deposit is paid or the ' +
      'order is in fulfilment.',
  })
  cancel(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.cancel(seller.sellerId, id);
  }
}
