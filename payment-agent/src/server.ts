/** Payment Agent: A2A server exposing the deposit lifecycle. */

import { type AgentCard, Role } from '@a2a-js/sdk';
import {
  type AgentExecutor,
  type ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express, { type Express } from 'express';
import { pathToFileURL } from 'node:url';

import { loadConfig, type Config } from './config.js';
import { GeminiExtractor, UnavailableExtractor, type Extractor } from './nlu.js';
import { SkillRouter, type Envelope, type Handlers } from './router.js';
import { GravvBackend } from './gravvBackend.js';
import { PaymentService, StubBackend, type PaymentBackend } from './service.js';

export const AGENT_NAME = 'CODLOCK Payment Agent';

export function buildCard(publicUrl: string): AgentCard {
  return {
    name: AGENT_NAME,
    description:
      'Collects the risk-decided deposit through Gravv before a cash-on-delivery ' +
      'order ships, and settles it once the courier reports the outcome.',
    version: '0.1.0',
    provider: { organization: 'CODLOCK', url: 'https://github.com/MarwenSAIDI/codlock' },
    supportedInterfaces: [{ url: `${publicUrl}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    securitySchemes: {},
    securityRequirements: [],
    signatures: [],
    documentationUrl: '',
    iconUrl: '',
    skills: [
      {
        id: 'collect_deposit',
        name: 'Collect deposit',
        description:
          'Turn an already-decided deposit amount into something the customer can pay ' +
          'in one tap through Gravv. Does not decide the amount — risk scoring does ' +
          'that upstream. A deposit of zero is legal and returns status "not_required" ' +
          'without touching Gravv. Idempotent on order_id.',
        tags: ['payments', 'gravv', 'deposit'],
        examples: ['Collect a 29.800 TND deposit for order ord_1 from customer C123.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
      {
        id: 'confirm_payment',
        name: 'Confirm payment',
        description:
          'Poll whether the deposit has actually been paid. Returns awaiting_payment ' +
          'until it clears, then paid. Safe to call repeatedly.',
        tags: ['payments', 'gravv'],
        examples: ['Has the deposit for order ord_1 been paid yet?'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
      {
        id: 'settle_order',
        name: 'Settle order',
        description:
          'Close the loop once the courier reports back. Accepted: the deposit is ' +
          'applied to the total and the remaining balance is returned. Refused: the ' +
          'deposit is retained against the courier round trip, and any seller ' +
          'shortfall is reported honestly.',
        tags: ['payments', 'settlement'],
        examples: ['Order ord_1 was refused; the courier fee was 8.000 TND.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
    ],
  };
}

/** Adapts the skill router to the A2A executor interface. */
class RoutedExecutor implements AgentExecutor {
  constructor(private readonly router: SkillRouter) {}

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const envelope = await this.router.handleMessage(context.userMessage);
    eventBus.publish({ kind: 'message', data: dataMessage(envelope, context) });
    eventBus.finished();
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}

function dataMessage(envelope: Envelope, context: RequestContext) {
  return {
    messageId: crypto.randomUUID(),
    contextId: context.contextId ?? '',
    taskId: context.taskId ?? '',
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'data' as const, value: envelope },
        metadata: undefined,
        filename: '',
        mediaType: 'application/json',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function selectBackend(config: Config): PaymentBackend {
  if (config.stubMode) return new StubBackend();
  if (!config.gravvApiKey) {
    throw new Error(
      'STUB_MODE is off but GRAVV_API_KEY is not set. Either set a ' +
        'grvSec_sandbox_... key or leave STUB_MODE=true.',
    );
  }
  return new GravvBackend(config);
}

export function selectExtractor(config: Config): Extractor {
  return config.geminiApiKey
    ? new GeminiExtractor(config.geminiApiKey, config.nluModel)
    : new UnavailableExtractor();
}

export function buildRouter(config: Config): SkillRouter {
  const service = new PaymentService(selectBackend(config));
  const handlers: Handlers = {
    collect_deposit: (input) => service.collectDeposit(input),
    confirm_payment: (input) => service.confirmPayment(input),
    settle_order: (input) => service.settleOrder(input),
  };
  return new SkillRouter(handlers, selectExtractor(config));
}

export function createApp(config: Config = loadConfig()): Express {
  const card = buildCard(config.publicUrl);
  const router = buildRouter(config);
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new RoutedExecutor(router),
  );

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // The demo console is a static page opened from disk (origin "null"), so it needs
  // permissive CORS to call this agent live on stage. Sandbox-only by intent; put a
  // real allowlist here before this ever faces the internet.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, A2A-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: card.name, skills: router.skills });
  });

  // Mount path matters: RemoteA2aAgent resolves peers from exactly this URL.
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: async () => card }),
  );
  app.use(
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  return app;
}

function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`${AGENT_NAME} listening on http://${config.host}:${config.port}`);
    console.log(`agent card at http://${config.host}:${config.port}/.well-known/agent-card.json`);
    if (config.stubMode) console.log('STUB_MODE=true — answering from fixtures, Gravv is not called.');
  });
}

// pathToFileURL, not string concatenation: on Windows argv[1] is "C:\path\server.ts"
// while import.meta.url is "file:///C:/path/server.ts", so a naive compare never
// matches and the server silently starts nothing.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
