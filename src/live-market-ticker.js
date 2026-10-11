// Real BTC/ETH quotes for the plaza market screen. Display only: nothing here trades, stores
// balances, or feeds the simulation. Quotes come from public exchange endpoints, tried in order
// with automatic fallback. When no source answers, the snapshot carries no numbers at all; this
// module never fills a gap with an estimate.
export const MARKET_ASSETS = Object.freeze(['BTC', 'ETH']);
export const STALE_AFTER_MS = 60_000;
export const OFFLINE_AFTER_MS = 10 * 60_000;
export const CANDLE_COUNT = 24;
const HEADERS = { 'User-Agent': 'MirrorTerra/1.0 (+https://mirrorterra.com)', Accept: 'application/json' };

const positive = (value) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(number) && number > 0 ? number : null;
};

function quoteFrom({ price, open, high, low, basis = '24h' }) {
  const last = positive(price), start = positive(open);
  if (last === null) throw new Error('missing price');
  return {
    price: last,
    change24hPct: start === null ? null : ((last - start) / start) * 100,
    changeBasis: basis,
    high24h: positive(high),
    low24h: positive(low)
  };
}

// One hourly candle from raw exchange fields; rejects anything that is not a consistent OHLC bar.
export function candleFrom(time, open, high, low, close) {
  const o = positive(open), h = positive(high), l = positive(low), c = positive(close);
  const t = Number(time);
  if ([o, h, l, c].includes(null) || !Number.isFinite(t)) return null;
  if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) return null;
  return { t: t < 1e12 ? t * 1000 : t, o, h, l, c };
}

// Each source: { name, quote, tickers(getJson) -> { BTC, ETH }, candles(getJson, symbol) -> OHLC bars oldest..newest }
export const MARKET_SOURCES = Object.freeze({
  coinbase: {
    name: 'Coinbase', quote: 'USD',
    async tickers(getJson) {
      const out = {};
      for (const symbol of MARKET_ASSETS) {
        const stats = await getJson(`https://api.exchange.coinbase.com/products/${symbol}-USD/stats`);
        out[symbol] = quoteFrom({ price: stats.last, open: stats.open, high: stats.high, low: stats.low });
      }
      return out;
    },
    async candles(getJson, symbol) {
      const rows = await getJson(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=3600`);
      // [time, low, high, open, close, volume], newest first
      return rows.slice(0, CANDLE_COUNT).map((row) => candleFrom(row[0], row[3], row[2], row[1], row[4])).reverse();
    }
  },
  kraken: {
    name: 'Kraken', quote: 'USD',
    async tickers(getJson) {
      const body = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD');
      if (body.error?.length) throw new Error(body.error.join(','));
      const result = body.result || {};
      const pick = (keys) => keys.map((key) => result[key]).find(Boolean);
      const out = {};
      for (const [symbol, keys] of [['BTC', ['XXBTZUSD', 'XBTUSD']], ['ETH', ['XETHZUSD', 'ETHUSD']]]) {
        const row = pick(keys);
        if (!row) throw new Error(`kraken missing ${symbol}`);
        // Kraken's "o" is the open since 00:00 UTC, not a rolling 24h open.
        out[symbol] = quoteFrom({ price: row.c?.[0], open: row.o, high: row.h?.[1], low: row.l?.[1], basis: 'utc-day' });
      }
      return out;
    },
    async candles(getJson, symbol) {
      const pair = symbol === 'BTC' ? 'XBTUSD' : 'ETHUSD';
      const body = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60`);
      const rows = Object.entries(body.result || {}).find(([key]) => key !== 'last')?.[1] || [];
      // [time, open, high, low, close, vwap, volume, count], oldest first
      return rows.slice(-CANDLE_COUNT).map((row) => candleFrom(row[0], row[1], row[2], row[3], row[4]));
    }
  },
  okx: {
    name: 'OKX', quote: 'USDT',
    async tickers(getJson) {
      const out = {};
      for (const symbol of MARKET_ASSETS) {
        const body = await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`);
        const row = body.data?.[0];
        if (!row) throw new Error(`okx missing ${symbol}`);
        out[symbol] = quoteFrom({ price: row.last, open: row.open24h, high: row.high24h, low: row.low24h });
      }
      return out;
    },
    async candles(getJson, symbol) {
      const body = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=1H&limit=${CANDLE_COUNT}`);
      // [ts, o, h, l, c, ...], newest first
      return (body.data || []).map((row) => candleFrom(row[0], row[1], row[2], row[3], row[4])).reverse();
    }
  },
  binance: {
    name: 'Binance', quote: 'USDT',
    async tickers(getJson) {
      const symbols = encodeURIComponent(JSON.stringify(MARKET_ASSETS.map((symbol) => `${symbol}USDT`)));
      const rows = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbols}`);
      const out = {};
      for (const symbol of MARKET_ASSETS) {
        const row = Array.isArray(rows) ? rows.find((item) => item.symbol === `${symbol}USDT`) : null;
        if (!row) throw new Error(`binance missing ${symbol}`);
        out[symbol] = quoteFrom({ price: row.lastPrice, open: row.openPrice, high: row.highPrice, low: row.lowPrice });
      }
      return out;
    },
    async candles(getJson, symbol) {
      const rows = await getJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=${CANDLE_COUNT}`);
      // [openTime, o, h, l, c, ...], oldest first
      return rows.map((row) => candleFrom(row[0], row[1], row[2], row[3], row[4]));
    }
  }
});

export const DEFAULT_SOURCE_ORDER = Object.freeze(['coinbase', 'kraken', 'okx', 'binance']);

export function parseSourceOrder(value) {
  if (typeof value !== 'string' || !value.trim()) return [...DEFAULT_SOURCE_ORDER];
  const picked = value.split(',').map((item) => item.trim().toLowerCase()).filter((item) => MARKET_SOURCES[item]);
  return picked.length ? [...new Set(picked)] : [...DEFAULT_SOURCE_ORDER];
}

export function createLiveMarketTicker({
  fetchImpl = globalThis.fetch, now = () => Date.now(), sources = DEFAULT_SOURCE_ORDER,
  pollMs = 15_000, candleMs = 5 * 60_000, timeoutMs = 6_000, logger = null
} = {}) {
  const order = sources.filter((key) => MARKET_SOURCES[key]);
  let latest = null; // { sourceKey, fetchedAt, assets }
  let sparklines = { sourceKey: null, fetchedAt: 0, bySymbol: {} };
  let preferred = 0, timer = null, running = null;

  async function getJson(url) {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: HEADERS, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(abort); }
  }

  async function refreshSparklines(sourceKey) {
    const source = MARKET_SOURCES[sourceKey], bySymbol = {};
    for (const symbol of MARKET_ASSETS) {
      try {
        const bars = (await source.candles(getJson, symbol)).filter(Boolean);
        if (bars.length >= 2) bySymbol[symbol] = bars;
      } catch (error) { logger?.warn?.({ source: sourceKey, symbol, err: error.message }, 'market candles unavailable'); }
    }
    sparklines = { sourceKey, fetchedAt: now(), bySymbol };
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      for (let step = 0; step < order.length; step += 1) {
        const index = (preferred + step) % order.length, key = order[index];
        try {
          const assets = await MARKET_SOURCES[key].tickers(getJson);
          latest = { sourceKey: key, fetchedAt: now(), assets };
          preferred = index;
          if (sparklines.sourceKey !== key || now() - sparklines.fetchedAt >= candleMs) await refreshSparklines(key);
          return true;
        } catch (error) {
          logger?.warn?.({ source: key, err: error.message }, 'market source unavailable');
        }
      }
      return false;
    })();
    try { return await running; } finally { running = null; }
  }

  function snapshot() {
    const age = latest ? now() - latest.fetchedAt : Infinity;
    if (!latest || age > OFFLINE_AFTER_MS) {
      return { status: 'offline', source: null, quote: null, asOf: latest ? new Date(latest.fetchedAt).toISOString() : null, assets: [] };
    }
    const source = MARKET_SOURCES[latest.sourceKey];
    const lines = sparklines.sourceKey === latest.sourceKey ? sparklines.bySymbol : {};
    return {
      status: age > STALE_AFTER_MS ? 'stale' : 'live',
      source: source.name,
      quote: source.quote,
      asOf: new Date(latest.fetchedAt).toISOString(),
      ageSeconds: Math.round(age / 1000),
      assets: MARKET_ASSETS.map((symbol) => {
        const candles = lines[symbol] || [];
        return { symbol, ...latest.assets[symbol], candles, sparkline: candles.map((bar) => bar.c) };
      })
    };
  }

  return {
    refresh, snapshot,
    start() {
      if (timer) return;
      refresh().catch(() => {});
      timer = setInterval(() => { refresh().catch(() => {}); }, pollMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
