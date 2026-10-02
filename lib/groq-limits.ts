/**
 * Lightweight per-process Groq throttle. Groq's provider-side 429 response remains
 * authoritative. Deployments with multiple instances need an external/shared queue.
 */
import OpenAI from 'openai';

const WINDOW_MS = 60_000;
const TOKEN_BUDGET = 6_800; // conservative margin below the observed free-tier 8k TPM
const MIN_SPACING_MS = 5_000;
const MAX_RETRY_WAIT_MS = 180_000;

const reservations: { at: number; estimated: number }[] = [];
let nextAllowedAt = 0;
let locked: Promise<void> = Promise.resolve();

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Conservative approximate accounting, NOT the provider's actual tokenizer. */
export function estimateTokens(prompt: string, completionAllowance: number): number {
  return Math.ceil(prompt.length / 2.6) + completionAllowance;
}

export function parseRetryMs(message: string, retryAfter: string | null = null): number | null {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const match = message.match(/(?:try again in|retry after|please retry in)\s*([\d.]+)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('ms') || unit.startsWith('milli') ? 1
    : unit === 'm' || unit.startsWith('min') ? 60_000
    : unit === 'h' || unit.startsWith('hour') ? 3_600_000 : 1000;
  return Math.ceil(n * multiplier);
}

/** Serialize reservations so simultaneous local requests cannot both reserve the same budget. */
export async function waitForGroqBudget(estimatedTokens: number): Promise<void> {
  const previous = locked;
  let release!: () => void;
  locked = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const tokens = Math.max(1, Math.min(TOKEN_BUDGET, estimatedTokens));
    for (;;) {
      const now = Date.now();
      while (reservations.length && reservations[0].at + WINDOW_MS <= now) reservations.shift();
      const used = reservations.reduce((sum, item) => sum + item.estimated, 0);
      const earliest = reservations.length ? reservations[0].at + WINDOW_MS - now + 500 : 0;
      const cooldown = Math.max(0, nextAllowedAt - now);
      const overflow = used + tokens > TOKEN_BUDGET;
      const waitMs = Math.max(cooldown, overflow ? earliest : 0);
      if (waitMs <= 0) {
        reservations.push({ at: now, estimated: tokens });
        nextAllowedAt = now + MIN_SPACING_MS;
        return;
      }
      await sleep(waitMs);
    }
  } finally {
    release();
  }
}

/** Retry 429 only after the duration recommended by Groq, including a small margin. */
export function groqRetryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof OpenAI.APIError) || error.status !== 429) return null;
  const headerValue = error.headers?.get?.('retry-after') ?? null;
  const supplied = parseRetryMs(error.message, headerValue);
  const delay = Math.min(MAX_RETRY_WAIT_MS, Math.max(supplied ?? 15_000 * attempt, 1500) + 1500);
  nextAllowedAt = Math.max(nextAllowedAt, Date.now() + delay);
  return delay;
}

export function groqPublicError(error: unknown): string {
  if (error instanceof OpenAI.APIError && error.status === 429) {
    return 'Groq временно ограничивает число токенов. Попробуйте ещё раз позднее или уменьшите объём материала.';
  }
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос AI';
}
