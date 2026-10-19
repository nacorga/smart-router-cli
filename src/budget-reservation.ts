export interface TokenPrices { input: number; output: number }
export interface CompletionReservation {
  admitted: boolean;
  body: Record<string, unknown>;
  inputTokenUpperBound: number;
  reserveUsd: number;
  requestedOutputTokens: number;
  maxOutputTokens: number;
  outputReduced: boolean;
}
/** Text-only reserve. Prices must include the maximum eligible endpoint/cache-write rates. */
export function reserveTextCompletion(
  request: Record<string, unknown>, prices: TokenPrices, remainingUsd: number,
  maxOutputTokens = 3072, minimumOutputTokens = 512,
): CompletionReservation {
  for (const n of [prices.input, prices.output, remainingUsd]) {
    if (!Number.isFinite(n) || n < 0) throw new Error('Invalid price or remaining budget');
  }
  for (const n of [maxOutputTokens, minimumOutputTokens]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid output token limit');
  }
  const body = structuredClone(request);
  if (!Array.isArray(body.messages)) throw new Error('Text messages required for budget reservation');
  for (const message of body.messages) {
    const content = message?.content;
    if (Array.isArray(content) && content.some(part => part?.type !== 'text')) {
      throw new Error('Non-text content requires a separate input cost bound');
    }
  }
  const requested = [body.max_tokens, body.max_completion_tokens].filter(n => n !== undefined);
  if (requested.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1)) {
    throw new Error('Invalid requested output limit');
  }
  const requestedOutputTokens = Math.min(maxOutputTokens, ...requested as number[]);
  const minimum = Math.min(minimumOutputTokens, requestedOutputTokens);
  let cap = requestedOutputTokens;
  const applyCap = () => {
    body.max_tokens = cap;
    if (body.max_completion_tokens !== undefined) body.max_completion_tokens = cap;
  };
  applyCap();
  let inputTokenUpperBound = Buffer.byteLength(JSON.stringify(body)) + 2048;
  let reserveUsd = inputTokenUpperBound * prices.input + cap * prices.output;
  if (reserveUsd > remainingUsd && prices.output > 0) {
    const affordable = Math.floor((remainingUsd - inputTokenUpperBound * prices.input - 1e-9) / prices.output);
    if (affordable >= minimum) {
      cap = Math.min(cap, affordable);
      applyCap();
      inputTokenUpperBound = Buffer.byteLength(JSON.stringify(body)) + 2048;
      reserveUsd = inputTokenUpperBound * prices.input + cap * prices.output;
    }
  }
  const reasoning = body.reasoning as {max_tokens?: unknown} | undefined;
  const reasoningFits = typeof reasoning?.max_tokens !== 'number' || reasoning.max_tokens < cap;
  return { admitted: reserveUsd <= remainingUsd && reasoningFits, body, inputTokenUpperBound, reserveUsd,
    requestedOutputTokens, maxOutputTokens: cap, outputReduced: cap < requestedOutputTokens };
}
