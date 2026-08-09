import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';

import { AppModule } from '../../src/app.module';
import { SupabaseService } from '../../src/database/supabase/supabase.service';
import { FirebaseService } from '../../src/database/firebase/firebase.service';
import { OrchestratorService } from '../../src/modules/orchestrator/orchestrator.service';
import { InMemorySupabaseService, Store } from './in-memory-supabase';

export const SELLER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_SELLER_ID = '22222222-2222-4222-8222-222222222222';

export interface OrchestratorStub {
  scoreRisk: jest.Mock;
  generatePreview: jest.Mock;
  createPaymentLink: jest.Mock;
  ping: jest.Mock;
  breakerState: { state: string; failures: number };
}

export interface TestContext {
  app: INestApplication;
  store: Store;
  orchestrator: OrchestratorStub;
  token: (sellerId?: string, overrides?: Record<string, unknown>) => string;
  sign: (body: unknown, secret: string) => string;
}

/**
 * Boots the real AppModule — same guards, pipes, interceptors and exception
 * filter as main.ts — with only the three external boundaries stubbed.
 */
export async function createTestApp(): Promise<TestContext> {
  const store: Store = {};
  const supabase = new InMemorySupabaseService(store);

  const orchestrator: OrchestratorStub = {
    scoreRisk: jest.fn(),
    generatePreview: jest.fn(),
    createPaymentLink: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
    breakerState: { state: 'CLOSED', failures: 0 },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseService)
    .useValue(supabase)
    .overrideProvider(FirebaseService)
    .useValue({ enabled: false, firestore: null, logEvent: jest.fn() })
    .overrideProvider(OrchestratorService)
    .useValue(orchestrator)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });

  // Mirrors main.ts. Helmet and CORS are omitted: they are transport-level
  // headers, not routing behaviour, and helmet interferes with supertest.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();

  const jwt = new JwtService({ secret: process.env.JWT_SECRET });

  return {
    app,
    store,
    orchestrator,
    token: (sellerId = SELLER_ID, overrides = {}) =>
      jwt.sign({ sub: sellerId, email: 'seller@codlock.tn', ...overrides }),
    sign: (body: unknown, secret: string) =>
      createHmac('sha256', secret)
        .update(typeof body === 'string' ? body : JSON.stringify(body))
        .digest('hex'),
  };
}

/**
 * Seed helpers — write straight to the store, bypassing the API.
 *
 * They refuse to insert a duplicate id: two rows sharing one id makes every
 * `.maybeSingle()` lookup fail as "multiple rows", which surfaces as a
 * confusing 500 far from the actual mistake.
 */
function push(store: Store, table: string, row: Record<string, any>) {
  const rows = (store[table] ??= []);
  if (rows.some((r) => r.id === row.id)) {
    throw new Error(
      `seed: ${table} already contains id ${row.id} — pass a distinct id override`,
    );
  }
  rows.push(row);
  return row;
}

export function seedCustomer(
  store: Store,
  overrides: Record<string, any> = {},
) {
  const customer = {
    id: '44444444-4444-4444-8444-444444444444',
    seller_id: SELLER_ID,
    phone: '+21620123456',
    name: 'Amine Ben Salah',
    zone: 'Sfax',
    total_orders: 0,
    successful_orders: 0,
    refused_orders: 0,
    risk_tier: 'MEDIUM',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  return push(store, 'customers', customer);
}

export function seedProduct(store: Store, overrides: Record<string, any> = {}) {
  const product = {
    id: '55555555-5555-4555-8555-555555555555',
    seller_id: SELLER_ID,
    sku: 'TSHIRT-BLK-001',
    title: 'Oversized Cotton Tee',
    price: 79.9,
    sizes: ['S', 'M', 'L'],
    colors: ['black', 'white'],
    image_url: null,
    category: 'apparel',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  return push(store, 'products', product);
}
