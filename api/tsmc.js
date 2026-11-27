// /api/tsmc.js — CommonJS Serverless API for Vercel (No package.json required)
// Uses Yahoo Finance v8/chart (no crumb required) + open.er-api.com FX fallback

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1m&range=1d&includePrePost=true`;

  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.meta) throw new Error(`Yahoo ${symbol} empty`);

  const meta = result.meta;
  const prevClose = Number(meta.chartPreviousClose || meta.previousClose || 0);

  // Extract latest non-null close from 1m pre/regular/post-market candles if available
  const closes = result?.indicators?.quote?.[0]?.close || [];
  let latestCandlePrice = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (typeof closes[i] === 'number' && Number.isFinite(closes[i]) && closes[i] > 0) {
      latestCandlePrice = closes[i];
      break;
    }
  }

  const price = Number(latestCandlePrice || meta.regularMarketPrice || 0);
  const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  return {
    price,
    prevClose,
    changePct: Number(changePct.toFixed(2)),
    regularMarketPrice: Number(meta.regularMarketPrice || price),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const responsePayload = {
    ok: false,
    updatedAt: new Date().toISOString(),
    tsm: null,
    tw2330: null,
    fx: { usdKrw: null, usdTwd: null },
  };

  // Run all Yahoo v8 chart calls + backup FX in parallel
  const [tsmRes, twRes, krwRes, twdRes, erFxRes] = await Promise.allSettled([
    fetchYahooChart('TSM'),
    fetchYahooChart('2330.TW'),
    fetchYahooChart('KRW=X'),
    fetchYahooChart('TWD=X'),
    fetch('https://open.er-api.com/v6/latest/USD', { headers: FETCH_HEADERS }).then((r) =>
      r.ok ? r.json() : null
    ),
  ]);

  if (tsmRes.status === 'fulfilled' && tsmRes.value.price > 0) {
    responsePayload.tsm = {
      price: Number(tsmRes.value.price.toFixed(2)),
      changePct: tsmRes.value.changePct,
      session: 'LIVE TICK',
    };
  }

  if (twRes.status === 'fulfilled' && twRes.value.price > 0) {
    responsePayload.tw2330 = {
      price: Number(twRes.value.price.toFixed(2)),
      changePct: twRes.value.changePct,
    };
  }

  // Real-time FX from Yahoo (KRW=X, TWD=X), falling back to open.er-api.com
  if (krwRes.status === 'fulfilled' && krwRes.value.price > 0) {
    responsePayload.fx.usdKrw = Number(krwRes.value.price.toFixed(2));
  }
  if (twdRes.status === 'fulfilled' && twdRes.value.price > 0) {
    responsePayload.fx.usdTwd = Number(twdRes.value.price.toFixed(3));
  }

  if (erFxRes.status === 'fulfilled' && erFxRes.value?.rates) {
    if (!responsePayload.fx.usdKrw && erFxRes.value.rates.KRW) {
      responsePayload.fx.usdKrw = Number(erFxRes.value.rates.KRW);
    }
    if (!responsePayload.fx.usdTwd && erFxRes.value.rates.TWD) {
      responsePayload.fx.usdTwd = Number(erFxRes.value.rates.TWD);
    }
  }

  responsePayload.ok = Boolean(
    responsePayload.tsm || responsePayload.tw2330 || responsePayload.fx.usdKrw
  );

  return res.status(200).json(responsePayload);
};
