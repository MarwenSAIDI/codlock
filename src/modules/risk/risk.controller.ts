import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RiskService } from './risk.service';
import { EvaluateRiskDto } from './dto/evaluate-risk.dto';

@ApiTags('Risk')
@ApiBearerAuth()
@Controller('risk')
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Post('evaluate')
  @ApiOperation({
    summary: 'Evaluate customer risk and derive a dynamic deposit',
    description:
      'Returns a 0–100 risk score, tier, and the deposit rate/amount to charge before shipping.',
  })
  evaluate(@Body() dto: EvaluateRiskDto) {
    return this.risk.evaluate(dto);
  }
}
