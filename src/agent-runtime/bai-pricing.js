// B.AI standard reference prices, USD per million tokens, checked 2026-10-17.
// https://docs.b.ai/llmservice/pricing-and-usage
// Exact model IDs are required: an unknown newer model must not bypass the budget.
// BAI_DAILY_BUDGET_USD: a positive dollar amount, or "unlimited" (the user's B.AI plan has no quota for Luna).
const rawDailyBudget = String(process.env.BAI_DAILY_BUDGET_USD ?? '').trim().toLowerCase();
export const MODEL_DAILY_BUDGET_UNLIMITED = ['unlimited', 'off', 'none'].includes(rawDailyBudget);
const configuredDailyBudget = Number(rawDailyBudget);
export const MODEL_DAILY_BUDGET_USD = MODEL_DAILY_BUDGET_UNLIMITED ? null
  : (Number.isFinite(configuredDailyBudget) && configuredDailyBudget > 0 ? configuredDailyBudget : 1.00);
export const MODEL_DAILY_BUDGET_NANO_USD = MODEL_DAILY_BUDGET_UNLIMITED ? 10n ** 18n
  : BigInt(Math.round(MODEL_DAILY_BUDGET_USD * 1e9));

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

export function baiPricedUsageNanoUsd(model, inputTokens, outputTokens, usage = {}) {
  if (model !== 'gpt-6-luna') return baiPricedNanoUsd(model, inputTokens, outputTokens);
  const rate = baiModelPrice(model, inputTokens);
  const read = usage.cacheReadTokens;
  const write = usage.cacheWriteTokens;
  const valid = Number.isSafeInteger(read) && read >= 0 && Number.isSafeInteger(write)
    && write >= 0 && read + write <= inputTokens;
  const uncached = valid ? inputTokens - read - write : 0;
  const cacheWrite = valid ? write : inputTokens;
  const cacheRead = valid ? read : 0;
  // If provider cache detail is absent, assume every input token was written.
  const nanoRate = (price) => BigInt(Math.round(price * 1_000));
  return nanoRate(rate.input) * BigInt(uncached)
    + nanoRate(rate.input * 1.25) * BigInt(cacheWrite)
    + nanoRate(rate.input * 0.1) * BigInt(cacheRead)
    + nanoRate(rate.output) * BigInt(outputTokens);
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
  // A fresh Luna cache entry costs 1.25x input. Reserve the worst case before
  // admission; provider-reported usage may later settle below this amount.
  const inputWritePremium = model === 'gpt-6-luna'
    ? (baiPricedNanoUsd(model, estimatedInputTokens, 0)
      - baiPricedNanoUsd(model, 0, 0) + 3n) / 4n : 0n;
  const reservedNanoUsd = ((priced + inputWritePremium) * 105n + 99n) / 100n;
  return { requestBytes, estimatedInputTokens, maxOutputTokens: maxTokens, reservedNanoUsd };
}

export function nanoUsdToUsd(value) {
  return Number(value) / 1_000_000_000;
}
