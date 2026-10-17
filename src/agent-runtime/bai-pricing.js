// B.AI standard reference prices, USD per million tokens, checked 2026-10-17.
// https://docs.b.ai/llmservice/pricing-and-usage
// Exact model IDs are required: an unknown newer model must not bypass the budget.
export const MODEL_DAILY_BUDGET_USD = 0.75;
export const MODEL_DAILY_BUDGET_NANO_USD = 750_000_000n;

const prices = new Map([
  ['claude-haiku-4.5', { input: 1, output: 5 }],
  ['claude-haiku-5.5', { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5,
    longThreshold: 100_000 }],
  ['claude-sonnet-4.5', { input: 3, output: 15 }],
  ['claude-sonnet-4.6', { input: 3, output: 15 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-5.5', { input: 2, output: 10 }],
  ['claude-opus-4.5', { input: 5, output: 25 }],
  ['claude-opus-4.6', { input: 5, output: 25 }],
  ['claude-opus-4.7', { input: 5, output: 25 }],
  ['claude-opus-4.8', { input: 5, output: 25 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-5.5', { input: 4, output: 20 }],
  ['gpt-6-luna', { input: 0.1, output: 0.5, longInput: 0.2, longOutput: 0.75,
    longThreshold: 272_000 }]
]);

function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/-(\d+)-(\d+)$/u, '-$1.$2');
}

export function baiModelPrice(model, inputTokens) {
  const listed = prices.get(normalizeModel(model));
  if (!listed) throw Object.assign(new Error('BAI_PRICE_UNAVAILABLE'), { code: 'BAI_PRICE_UNAVAILABLE' });
  const long = listed.longThreshold && inputTokens > listed.longThreshold;
  return { input: long ? listed.longInput : listed.input,
    output: long ? listed.longOutput : listed.output };
}

// B.AI's per-million-token USD rate is numerically nanodollars per thousand tokens.
export function baiPricedNanoUsd(model, inputTokens, outputTokens) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0
      || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new RangeError('BAI_TOKEN_COUNT_INVALID');
  }
  const rate = baiModelPrice(model, inputTokens);
  return BigInt(Math.round(rate.input * 1_000)) * BigInt(inputTokens)
    + BigInt(Math.round(rate.output * 1_000)) * BigInt(outputTokens);
}

export function baiAdmissionEstimate({ model, serializedBody, maxTokens }) {
  if (typeof serializedBody !== 'string' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new TypeError('BAI_ADMISSION_INPUT_INVALID');
  }
  const requestBytes = Buffer.byteLength(serializedBody, 'utf8');
  // One token cannot encode fewer than one input byte. Include protocol overhead,
  // then a 10% safety margin; do not reserve the model's full context window.
  const estimatedInputTokens = Math.ceil((requestBytes + 512) * 1.1);
  const priced = baiPricedNanoUsd(model, estimatedInputTokens, maxTokens);
  const reservedNanoUsd = (priced * 105n + 99n) / 100n;
  return { requestBytes, estimatedInputTokens, maxOutputTokens: maxTokens, reservedNanoUsd };
}

export function nanoUsdToUsd(value) {
  return Number(value) / 1_000_000_000;
}
