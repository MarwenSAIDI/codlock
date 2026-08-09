/** Runtime configuration. Every secret comes from the environment, never from git. */

import 'dotenv/config';

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value.trim());

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface Config {
  /** true: answer from fixtures, touch no external service, need no credentials. */
  stubMode: boolean;
  host: string;
  port: number;
  publicUrl: string;
  logLevel: string;

  gravvApiKey: string | undefined;
  gravvAllowLiveWrites: boolean;
  gravvToolsets: string;
  gravvSellerAccountId: string | undefined;
  gravvSourceId: string | undefined;
  settlementCurrency: string;

  /**
   * Used only for the natural-language fallback, where an LLM turns a free-text
   * delegation into a validated schema. It never decides an amount or moves money.
   */
  geminiApiKey: string | undefined;
  nluModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    stubMode: bool(env.STUB_MODE, true),
    host: env.PAYMENT_HOST ?? '127.0.0.1',
    port: num(env.PAYMENT_PORT, 8001),
    publicUrl: env.PAYMENT_PUBLIC_URL ?? 'http://127.0.0.1:8001',
    logLevel: env.LOG_LEVEL ?? 'INFO',

    gravvApiKey: env.GRAVV_API_KEY || undefined,
    gravvAllowLiveWrites: bool(env.GRAVV_ALLOW_LIVE_WRITES, false),
    gravvToolsets:
      env.GRAVV_TOOLSETS ??
      'customers,accounts,collections,payment-links,kyc,webhooks',
    gravvSellerAccountId: env.GRAVV_SELLER_ACCOUNT_ID || undefined,
    gravvSourceId: env.GRAVV_SOURCE_ID || undefined,
    settlementCurrency: env.SETTLEMENT_CURRENCY ?? 'USD',

    geminiApiKey: env.GEMINI_API_KEY || undefined,
    nluModel: env.NLU_MODEL ?? 'gemini-flash-latest',
  };
}
