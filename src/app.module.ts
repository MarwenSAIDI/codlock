import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

import { SupabaseModule } from './database/supabase/supabase.module';
import { FirebaseModule } from './database/firebase/firebase.module';

import { AuthModule } from './modules/auth/auth.module';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ProductsModule } from './modules/products/products.module';
import { RiskModule } from './modules/risk/risk.module';
import { FittingModule } from './modules/fitting/fitting.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // ── Global config (validated at boot) ──
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: false },
    }),

    // ── Basic abuse protection ──
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    // ── Infrastructure (global) ──
    SupabaseModule,
    FirebaseModule,
    OrchestratorModule,
    AuthModule,

    // ── Feature modules ──
    CustomersModule,
    ProductsModule,
    RiskModule,
    FittingModule,
    OrdersModule,
    PaymentsModule,
    AnalyticsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: LoggingInterceptor wraps ResponseInterceptor.
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
