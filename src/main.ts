import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest keeps the raw request body on `req.rawBody` so webhook HMAC
    // signatures (Gravv + social chat parsers) can be verified against the
    // exact received bytes.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('port') as number;
  const apiPrefix = config.get<string>('apiPrefix') as string;
  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];

  // ── Global HTTP hardening ──
  app.use(helmet());
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });

  // apiPrefix already carries the version (e.g. "api/v1"), so routes resolve
  // to /api/v1/<controller>. No separate URI versioning to avoid /v1/v1.
  app.setGlobalPrefix(apiPrefix);

  // ── Strict DTO validation everywhere ──
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown props
      forbidNonWhitelisted: true, // reject unknown props
      transform: true, // coerce payloads to DTO classes
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  // ── Swagger / OpenAPI ──
  const swaggerConfig = new DocumentBuilder()
    .setTitle('CODLOCK Backend Core')
    .setDescription(
      'AI-driven trust & confidence layer for social e-commerce — order lifecycle, ' +
        'virtual fitting, risk-based deposits (Gravv), and seller analytics.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Orders')
    .addTag('Products')
    .addTag('Customers')
    .addTag('Fitting Room')
    .addTag('Risk')
    .addTag('Analytics')
    .addTag('Health')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port);
  logger.log(`CODLOCK core listening on http://localhost:${port}/${apiPrefix}`);
  logger.log(`Swagger UI at http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();
