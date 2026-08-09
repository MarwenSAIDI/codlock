import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedSeller,
  CurrentSeller,
} from '../../common/decorators/current-seller.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'List all customers',
    description: 'Paginated, most recently updated first.',
  })
  findAll(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.customers.findAllBySeller(seller.sellerId, pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a customer by id' })
  findOne(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customers.findOneForSeller(seller.sellerId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a customer' })
  create(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(seller.sellerId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(seller.sellerId, id, dto);
  }
}
