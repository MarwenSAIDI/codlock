/**
 * A thin MCP client over `@gravvfi/mcp`.
 *
 * The Gravv MCP is a stdio process we spawn and keep alive for the life of the agent.
 * Everything money-related goes through it rather than through raw HTTP, so the
 * server's own safety rules — the two-call `confirm: true` gate, automatic idempotency
 * keys, cardholder-data redaction — apply to us too instead of being reimplemented.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { Config } from './config.js';

export class GravvError extends Error {
  override readonly name = 'GravvError';
  constructor(
    readonly tool: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** What a Gravv tool call returns once the MCP's JSON envelope is unwrapped. */
interface GravvEnvelope {
  environment?: 'sandbox' | 'live';
  data?: unknown;
  error?: string;
  status?: number;
  // Present on the first, unexecuted call of a money-moving tool.
  willDo?: string;
}

export class GravvMcp {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly config: Config) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client(
        { name: 'codlock-payment-agent', version: '0.1.0' },
        { capabilities: {} },
      );
      const transport = new StdioClientTransport({
        // npx.cmd on Windows; npx elsewhere.
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', '@gravvfi/mcp', `--toolsets=${this.config.gravvToolsets}`],
        env: {
          ...(process.env as Record<string, string>),
          GRAVV_API_KEY: this.config.gravvApiKey ?? '',
          ...(this.config.gravvAllowLiveWrites
            ? { GRAVV_ALLOW_LIVE_WRITES: 'true' }
            : {}),
        },
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })();

    return this.connecting;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.connecting = null;
  }

  /** Call a tool and unwrap Gravv's envelope, turning its errors into GravvError. */
  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args });

    const text = (result.content as { type: string; text?: string }[] | undefined)
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');

    if (!text) throw new GravvError(tool, null, 'Gravv returned an empty response.');

    let envelope: GravvEnvelope;
    try {
      envelope = JSON.parse(text) as GravvEnvelope;
    } catch {
      throw new GravvError(tool, null, `Gravv returned non-JSON: ${text.slice(0, 200)}`);
    }

    if (envelope.error) {
      throw new GravvError(tool, envelope.status ?? null, envelope.error);
    }
    if (envelope.willDo) {
      // Reaching here means a money-moving call went out without confirm: true.
      // That is our bug, not the user's — the preview is never what we want.
      throw new GravvError(
        tool,
        null,
        `${tool} returned a preview instead of executing. Pass confirm: true. It said: ${envelope.willDo}`,
      );
    }
    return (envelope.data ?? envelope) as T;
  }
}
