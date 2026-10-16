// A minimal typed client for TypeSafe's System One API (Jev): one request
// carries a shared `state` and many named questions; answers come back under
// the same names. Only the Choice question type is needed so far. Given a
// `JevLog`, every call (failed ones too) is recorded in `public.jev_calls`.

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE_STATUSES = [429, 529];
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ChoiceQuestion<Option extends string = string> {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<Option, JsonValue>;
}

export interface ChoiceAnswer<Option extends string = string> {
  type: "choice";
  choice: Option;
  probabilities: Record<Option, number>;
  confidence: number;
}

export interface SystemOneResult<Answers> {
  model: string;
  answers: Answers;
  usage: { input_tokens: number; output_tokens: number };
}

export type ChoiceAnswers<Q extends Record<string, ChoiceQuestion>> = {
  [K in keyof Q]: Q[K] extends ChoiceQuestion<infer O> ? ChoiceAnswer<O> : never;
};

export interface JevLog {
  db: SupabaseClient;
  fn: string;
  dryRun?: boolean;
}

export class JevClient {
  constructor(private apiKey: string, private model: string, private log?: JevLog) {}

  async ask<Q extends Record<string, ChoiceQuestion>>(
    state: JsonValue,
    questions: Q,
    linkId?: string,
  ): Promise<SystemOneResult<ChoiceAnswers<Q>>> {
    const started = Date.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    let attempts = 0;
    try {
      for (;;) {
        attempts++;
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body,
        });
        if (res.ok) {
          const result: SystemOneResult<ChoiceAnswers<Q>> = await res.json();
          await this.record({ state, questions, linkId, started, attempts, result });
          return result;
        }
        if (!RETRYABLE_STATUSES.includes(res.status) || attempts >= MAX_ATTEMPTS) {
          throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** (attempts - 1)));
      }
    } catch (e) {
      await this.record({ state, questions, linkId, started, attempts, error: String(e) });
      throw e;
    }
  }

  private async record(call: {
    state: JsonValue;
    questions: Record<string, ChoiceQuestion>;
    linkId?: string;
    started: number;
    attempts: number;
    result?: SystemOneResult<unknown>;
    error?: string;
  }) {
    if (!this.log) return;
    const { error } = await this.log.db.from("jev_calls").insert({
      fn: this.log.fn,
      link_id: call.linkId ?? null,
      dry_run: this.log.dryRun ?? false,
      requested_model: this.model,
      model: call.result?.model ?? null,
      state: call.state,
      questions: call.questions,
      answers: call.result?.answers ?? null,
      input_tokens: call.result?.usage.input_tokens ?? null,
      output_tokens: call.result?.usage.output_tokens ?? null,
      attempts: call.attempts,
      duration_ms: Date.now() - call.started,
      error: call.error ?? null,
    });
    if (error) console.error("jev_calls write failed", error);
  }
}

