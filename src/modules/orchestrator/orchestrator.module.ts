import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OrchestratorService } from './orchestrator.service';

/**
 * Global HTTP gateway to the Codlock Orchestrator Agent. Exposed app-wide so
 * fitting/risk/payment modules share one resilient client + circuit breaker.
 */
@Global()
@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: config.get<number>('orchestrator.timeoutMs'),
        maxRedirects: 2,
      }),
    }),
  ],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
