import * as Joi from 'joi';

/**
 * Fail-fast validation of the runtime environment. If a required key is
 * missing or malformed, the app refuses to boot instead of crashing later
 * on the first request that needs it.
 */
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGINS: Joi.string().allow('').optional(),

  // Security
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('1d'),

  // Supabase
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
  SUPABASE_ANON_KEY: Joi.string().optional().allow(''),
  SUPABASE_SCHEMA: Joi.string().default('public'),

  // Firebase — either an inline key OR a service-account file path.
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().optional().allow(''),
  FIREBASE_PRIVATE_KEY: Joi.string().optional().allow(''),
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().optional().allow(''),
  FIREBASE_DATABASE_URL: Joi.string().uri().optional().allow(''),

  // Orchestrator
  ORCHESTRATOR_BASE_URL: Joi.string().uri().required(),
  ORCHESTRATOR_API_KEY: Joi.string().optional().allow(''),
  ORCHESTRATOR_TIMEOUT_MS: Joi.number().default(15000),
  ORCHESTRATOR_MAX_RETRIES: Joi.number().default(3),
  ORCHESTRATOR_RETRY_DELAY_MS: Joi.number().default(500),
  ORCHESTRATOR_CB_FAILURE_THRESHOLD: Joi.number().default(5),
  ORCHESTRATOR_CB_OPEN_MS: Joi.number().default(30000),

  // Gravv
  GRAVV_API_BASE_URL: Joi.string().uri().required(),
  GRAVV_API_KEY: Joi.string().required(),
  GRAVV_WEBHOOK_SECRET: Joi.string().required(),

  // Social webhook
  SOCIAL_WEBHOOK_SECRET: Joi.string().optional().allow(''),

  // Risk engine
  DEPOSIT_RATE_TRUSTED: Joi.number().min(0).max(1).default(0),
  DEPOSIT_RATE_MEDIUM: Joi.number().min(0).max(1).default(0.1),
  DEPOSIT_RATE_HIGH: Joi.number().min(0).max(1).default(0.2),
  RISK_HIGH_THRESHOLD: Joi.number().min(0).max(100).default(70),
  RISK_MEDIUM_THRESHOLD: Joi.number().min(0).max(100).default(40),
});
