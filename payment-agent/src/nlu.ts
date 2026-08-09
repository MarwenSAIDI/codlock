/**
 * Natural-language fallback for ADK-style delegation.
 *
 * The orchestrator uses google-adk's `RemoteA2aAgent`, which delegates by having its
 * LLM write a sentence rather than a structured envelope. This module turns that
 * sentence into `{ skill, input }`.
 *
 * The boundary matters: the model only **transcribes** a request into a shape. What it
 * produces is then validated by the same Zod schema as any structured call, and handed
 * to the same deterministic handler. It never decides a deposit amount, never chooses
 * an outcome, and never talks to Gravv. If it hallucinates a field, validation rejects
 * it and the caller gets `invalid_input` — not a payment.
 */

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface Extraction {
  skill: string;
  input: Record<string, unknown>;
}

export interface Extractor {
  extract(text: string): Promise<Extraction>;
}

const INSTRUCTIONS = `You translate a request about a cash-on-delivery order deposit
into a single JSON object. You do not answer the request and you do not invent values.

Reply with exactly: {"skill": "<one of the skills>", "input": { ... }}

Skills and their required inputs:

collect_deposit — make an already-decided deposit payable.
  order_id      string
  seller_id     string
  customer      { customer_id, full_name, phone, email?, zone? }
  order_total   { amount: decimal string, currency: 3 letters }
  deposit       { amount: decimal string, currency: 3 letters }
  deposit_rate  number 0..1
  risk_score    integer 0..100
  channel       "instagram" | "whatsapp"

confirm_payment — check whether the deposit has been paid.
  payment_id    string
  order_id      string

settle_order — close the loop after the courier reports back.
  order_id      string
  payment_id    string
  outcome       "accepted" | "refused"
  courier_fee   { amount, currency }   required when refused

Rules:
- Amounts are decimal STRINGS: "29.800", never the number 29.8.
- Copy values from the request. If a required value is absent, omit the field —
  never guess an amount, an id, or an outcome.
- Output the JSON object only.`;

/** Calls Gemini to transcribe free text into a skill call. */
export class GeminiExtractor implements Extractor {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(text: string): Promise<Extraction> {
    const response = await this.fetchImpl(
      `${GEMINI_ENDPOINT}/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Gemini returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini returned no candidate text.');

    const parsed = JSON.parse(raw) as Partial<Extraction>;
    if (typeof parsed.skill !== 'string') {
      throw new Error(`Extraction has no skill: ${raw.slice(0, 200)}`);
    }
    return {
      skill: parsed.skill,
      input: (parsed.input ?? {}) as Record<string, unknown>,
    };
  }
}

/**
 * Used when no Gemini key is configured. Refuses rather than guessing — a payment
 * agent that invents a deposit from an unparsed sentence is worse than one that says
 * it cannot read the sentence.
 */
export class UnavailableExtractor implements Extractor {
  async extract(): Promise<Extraction> {
    throw new Error(
      'A plain-text request arrived but natural-language extraction is not configured. ' +
        'Set GEMINI_API_KEY, or send a structured {"skill", "input"} data part.',
    );
  }
}
