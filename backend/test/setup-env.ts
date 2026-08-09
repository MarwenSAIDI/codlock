/**
 * Runs before the e2e specs are imported, because AppModule calls
 * `ConfigModule.forRoot()` at module-load time and its Joi schema rejects a
 * half-configured environment. Values are dummies — every external boundary
 * is replaced by a test double.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.API_PREFIX = 'api/v1';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'false';

// A high limit so the shared throttler never trips across a suite of requests.
process.env.THROTTLE_LIMIT = '100000';

process.env.JWT_SECRET = 'e2e-test-secret-at-least-16-chars';
process.env.JWT_EXPIRES_IN = '1h';

process.env.SUPABASE_URL = 'https://e2e.supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'e2e-service-role-key';
process.env.SUPABASE_SCHEMA = 'public';

process.env.FIREBASE_PROJECT_ID = 'codlock-e2e';

process.env.ORCHESTRATOR_BASE_URL = 'http://orchestrator.test';
process.env.ORCHESTRATOR_TIMEOUT_MS = '1000';
process.env.ORCHESTRATOR_MAX_RETRIES = '0';

process.env.GRAVV_API_BASE_URL = 'https://gravv.test';
process.env.GRAVV_API_KEY = 'e2e-gravv-key';
process.env.GRAVV_WEBHOOK_SECRET = 'e2e-gravv-webhook-secret';
process.env.SOCIAL_WEBHOOK_SECRET = 'e2e-social-webhook-secret';

process.env.DEPOSIT_RATE_TRUSTED = '0';
process.env.DEPOSIT_RATE_MEDIUM = '0.10';
process.env.DEPOSIT_RATE_HIGH = '0.20';
process.env.RISK_HIGH_THRESHOLD = '70';
process.env.RISK_MEDIUM_THRESHOLD = '40';
