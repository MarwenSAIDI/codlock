import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentSeller,
  AuthenticatedSeller,
} from '../../common/decorators/current-seller.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated seller's catalog" })
  findAll(@CurrentSeller() seller: AuthenticatedSeller) {
    return this.products.findAllBySeller(seller.sellerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a product by id' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a product to the catalog' })
  create(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(seller.sellerId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product' })
  update(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(seller.sellerId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a product' })
  remove(
    @CurrentSeller() seller: AuthenticatedSeller,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.remove(seller.sellerId, id);
  }
}
