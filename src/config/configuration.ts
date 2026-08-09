/**
 * Strongly-typed configuration namespace, loaded once at bootstrap.
 * Access via `ConfigService.get('<key>')` or the typed helpers below.
 */
const env = process.env.NODE_ENV ?? 'development';

export default () => ({
  env,
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  // Interactive API docs are unauthenticated, so they stay off in production
  // unless an operator opts in explicitly.
  swaggerEnabled: process.env.SWAGGER_ENABLED
    ? process.env.SWAGGER_ENABLED === 'true'
    : env !== 'production',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
    // Reserved for a future shared store (see app.module.ts). Unused until a
    // Redis storage adapter is wired in for multi-instance deployment.
    redisUrl: process.env.THROTTLE_REDIS_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET as string,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },

  supabase: {
    url: process.env.SUPABASE_URL as string,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    anonKey: process.env.SUPABASE_ANON_KEY,
    schema: process.env.SUPABASE_SCHEMA ?? 'public',
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID as string,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL as string,
    // Normalise escaped newlines that come from single-line env vars.
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    databaseUrl: process.env.FIREBASE_DATABASE_URL,
  },

  orchestrator: {
    baseUrl: process.env.ORCHESTRATOR_BASE_URL as string,
    apiKey: process.env.ORCHESTRATOR_API_KEY as string,
    timeoutMs: parseInt(process.env.ORCHESTRATOR_TIMEOUT_MS ?? '15000', 10),
    maxRetries: parseInt(process.env.ORCHESTRATOR_MAX_RETRIES ?? '3', 10),
    retryDelayMs: parseInt(
      process.env.ORCHESTRATOR_RETRY_DELAY_MS ?? '500',
      10,
    ),
    circuitBreaker: {
      failureThreshold: parseInt(
        process.env.ORCHESTRATOR_CB_FAILURE_THRESHOLD ?? '5',
        10,
      ),
      openMs: parseInt(process.env.ORCHESTRATOR_CB_OPEN_MS ?? '30000', 10),
    },
  },

  gravv: {
    baseUrl: process.env.GRAVV_API_BASE_URL as string,
    apiKey: process.env.GRAVV_API_KEY as string,
    webhookSecret: process.env.GRAVV_WEBHOOK_SECRET as string,
  },

  social: {
    webhookSecret: process.env.SOCIAL_WEBHOOK_SECRET as string,
    // Chat webhook replay window: signed payloads older/newer than this are
    // rejected. Also see the event-id dedup in record_chat_webhook_event.
    maxSkewSeconds: parseInt(
      process.env.SOCIAL_WEBHOOK_MAX_SKEW_SECONDS ?? '300',
      10,
    ),
  },

  risk: {
    depositRates: {
      trusted: parseFloat(process.env.DEPOSIT_RATE_TRUSTED ?? '0'),
      medium: parseFloat(process.env.DEPOSIT_RATE_MEDIUM ?? '0.10'),
      high: parseFloat(process.env.DEPOSIT_RATE_HIGH ?? '0.20'),
    },
    thresholds: {
      high: parseInt(process.env.RISK_HIGH_THRESHOLD ?? '70', 10),
      medium: parseInt(process.env.RISK_MEDIUM_THRESHOLD ?? '40', 10),
    },
  },
});
