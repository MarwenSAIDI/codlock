import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FittingService } from './fitting.service';
import { GeneratePreviewDto } from './dto/generate-preview.dto';

@ApiTags('Fitting Room')
@ApiBearerAuth()
@Controller('fitting')
export class FittingController {
  constructor(private readonly fitting: FittingService) {}

  @Post('generate-preview')
  @ApiOperation({
    summary: 'Generate a virtual try-on preview',
    description:
      'Forwards the customer photo + product to the Fitting Agent and stores the rendered preview URL.',
  })
  generatePreview(@Body() dto: GeneratePreviewDto) {
    return this.fitting.generatePreview(dto);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'List fitting sessions for an order' })
  findByOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.fitting.findByOrder(orderId);
  }
}
