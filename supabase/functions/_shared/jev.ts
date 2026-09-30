// A minimal typed client for TypeSafe's System One API (Jev): one request
// carries a shared `state` and many named questions; answers come back under
// the same names. Only the Choice question type is needed so far.

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

export class JevClient {
  constructor(private apiKey: string, private model: string) {}

  async ask<Q extends Record<string, ChoiceQuestion>>(
    state: JsonValue,
    questions: Q,
  ): Promise<SystemOneResult<ChoiceAnswers<Q>>> {
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body,
      });
      if (res.ok) return await res.json();
      if (!RETRYABLE_STATUSES.includes(res.status) || attempt >= MAX_ATTEMPTS) {
        throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
    }
  }
}

