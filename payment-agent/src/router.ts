/**
 * Envelope handling and skill dispatch.
 *
 * Two call styles reach the same handlers:
 *
 *   structured   parts: [{ content: { $case: "data", value: { skill, input } } }]
 *   plain text   parts: [{ content: { $case: "text", value: "collect 29.8 TND ..." } }]
 *
 * The structured path is primary and involves no model at all. The text path exists
 * because google-adk's RemoteA2aAgent delegates in natural language; it runs the text
 * through an extractor and then joins the same validated pipeline.
 *
 * Responses always carry one data part:
 *   { skill, ok: true,  output: {...} }
 *   { skill, ok: false, error: { type, message } }
 */

import type { Message, Part } from '@a2a-js/sdk';
import type { z } from 'zod';

import type { Extractor } from './nlu.js';
import { SKILL_INPUTS, SKILL_NAMES, type SkillName } from './schemas.js';

export type Envelope =
  | { skill: string; ok: true; output: unknown }
  | { skill: string; ok: false; error: { type: string; message: string } };

export type Handlers = {
  [K in SkillName]: (input: z.infer<(typeof SKILL_INPUTS)[K]>) => Promise<unknown>;
};

export function fail(skill: string, type: string, message: string): Envelope {
  return { skill, ok: false, error: { type, message } };
}

/** Pull a structured envelope out of the first data part, if there is one. */
export function readDataPart(message: Message | undefined): Record<string, unknown> | null {
  for (const part of message?.parts ?? []) {
    if (part.content?.$case === 'data' && part.content.value) {
      return part.content.value as Record<string, unknown>;
    }
  }
  return null;
}

/** Concatenate every text part, which is what an ADK delegation looks like. */
export function readText(message: Message | undefined): string {
  return (message?.parts ?? [])
    .map((part: Part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export class SkillRouter {
  constructor(
    private readonly handlers: Handlers,
    private readonly extractor: Extractor,
  ) {}

  get skills(): string[] {
    return [...SKILL_NAMES];
  }

  /** Work out what was asked, from either call style, then run it. */
  async handleMessage(message: Message | undefined): Promise<Envelope> {
    const data = readDataPart(message);

    if (data && typeof data.skill === 'string') {
      return this.dispatch(data.skill, (data.input ?? {}) as Record<string, unknown>);
    }

    // A JSON envelope pasted into a text part — common when hand-testing with curl.
    const text = readText(message);
    if (!text) {
      return fail('', 'missing_skill', `Send a data part {"skill", "input"}, or plain text. Known skills: ${this.skills.join(', ')}.`);
    }

    const inlineJson = tryParseEnvelope(text);
    if (inlineJson) {
      return this.dispatch(inlineJson.skill, inlineJson.input);
    }

    let extracted;
    try {
      extracted = await this.extractor.extract(text);
    } catch (error) {
      return fail('', 'extraction_failed', errorMessage(error));
    }
    return this.dispatch(extracted.skill, extracted.input);
  }

  /** Validate then run. Everything reaches a handler through here. */
  async dispatch(skill: string, rawInput: Record<string, unknown>): Promise<Envelope> {
    if (!isSkill(skill)) {
      return fail(skill, 'unknown_skill', `No skill "${skill}". Known: ${this.skills.join(', ')}.`);
    }

    const parsed = SKILL_INPUTS[skill].safeParse(rawInput);
    if (!parsed.success) {
      return fail(skill, 'invalid_input', JSON.stringify(parsed.error.issues));
    }

    try {
      const handler = this.handlers[skill] as (input: unknown) => Promise<unknown>;
      return { skill, ok: true, output: await handler(parsed.data) };
    } catch (error) {
      // The boundary is where we stop the bleed: a dead backend is a structured
      // error the orchestrator can branch on, never an HTTP 500.
      return fail(skill, errorName(error), errorMessage(error));
    }
  }
}

function isSkill(value: string): value is SkillName {
  return (SKILL_NAMES as string[]).includes(value);
}

function tryParseEnvelope(
  text: string,
): { skill: string; input: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed.skill === 'string') {
      return {
        skill: parsed.skill,
        input: (parsed.input ?? {}) as Record<string, unknown>,
      };
    }
  } catch {
    // Not JSON. Fall through to the language model.
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
