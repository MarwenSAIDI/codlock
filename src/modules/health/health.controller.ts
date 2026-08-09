import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { OrchestratorService } from '../orchestrator/orchestrator.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly orchestrator: OrchestratorService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness + downstream orchestrator status' })
  async check() {
    const orchestratorUp = await this.orchestrator.ping();
    return {
      status: 'ok',
      uptime: process.uptime(),
      orchestrator: {
        reachable: orchestratorUp,
        breaker: this.orchestrator.breakerState,
      },
    };
  }
}
