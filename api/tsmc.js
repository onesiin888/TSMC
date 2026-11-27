// /api/tsmc.js — Vercel CommonJS Serverless API (No package.json required)
// 1) 환율: 두나무(하나은행 실시간 고시환율) 1순위 -> Yahoo 실시간 외환(KRW=X, TWD=X) 2순위 -> open.er-api 3순위
// 2) 미국 ADR(TSM): Finnhub 공식 API(환경변수 설정 시) -> Yahoo v8 이중화 서버(query1/query2, 프리·정규·애프터 포함)
// 3) 대만 본주(2330.TW): Yahoo v8 이중화 서버(query1/query2)

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Fetch JSON with an explicit timeout so a slow upstream never hangs the serverless function.
 */
async function fetchJson(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1순위 환율: 두나무(하나은행) 실시간 고시환율 (API 키 불필요, 네이버·토스 환율과 거의 동일)
 */
async function fetchDunamuFx() {
  const url =
    'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD,FRX.KRWTWD';
  const data = await fetchJson(url, 3500);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Dunamu FX empty');
  }

  let usdKrw = null;
  let twdKrw = null;

  for (const item of data) {
    const unit = Number(item.currencyUnit || 1);
    const price = Number(item.basePrice || 0) / unit;
    if (item.code === 'FRX.KRWUSD' && price > 0) usdKrw = price;
    if (item.code === 'FRX.KRWTWD' && price > 0) twdKrw = price;
  }

  const usdTwd = usdKrw && twdKrw ? usdKrw / twdKrw : null;
  if (!usdKrw && !usdTwd) throw new Error('Dunamu FX parse failed');

  return {
    usdKrw: usdKrw ? Number(usdKrw.toFixed(2)) : null,
    usdTwd: usdTwd ? Number(usdTwd.toFixed(3)) : null,
    source: 'Hana Bank (Dunamu)',
  };
}

/**
 * 선택(옵션) 1순위 미국 주식: Finnhub 공식 실시간 API (Vercel 환경변수 FINNHUB_API_KEY 설정 시 자동 활성화)
 */
async function fetchFinnhubQuote(symbol, apiKey) {
  if (!apiKey) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    symbol
  )}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, 3500);

  const price = Number(json?.c || 0);
  const prevClose = Number(json?.pc || 0);
  if (price <= 0) throw new Error('Finnhub empty price');

  const changePct =
    typeof json?.dp === 'number'
      ? json.dp
      : prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : 0;

  return {
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    session: 'FINNHUB LIVE',
    source: 'Finnhub Official',
  };
}

/**
 * 야후 파이낸스 v8 차트 API (query1 실패 시 query2 자동 백업, 1분봉 기준 프리/정규/애프터 최신가 추출)
 */
async function fetchYahooChart(symbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastError = null;

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?interval=1m&range=1d&includePrePost=true`;
      const json = await fetchJson(url, 4000);
      const result = json?.chart?.result?.[0];
      if (!result || !result.meta) throw new Error(`Yahoo ${symbol} empty`);

      const meta = result.meta;
      const prevClose = Number(meta.chartPreviousClose || meta.previousClose || 0);

      // Extract the most recent valid 1-minute candle close (includes pre-market & after-hours)
      const closes = result?.indicators?.quote?.[0]?.close || [];
      let latestCandlePrice = null;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === 'number' && Number.isFinite(closes[i]) && closes[i] > 0) {
          latestCandlePrice = closes[i];
          break;
        }
      }

      const price = Number(latestCandlePrice || meta.regularMarketPrice || 0);
      if (price <= 0) throw new Error(`Yahoo ${symbol} invalid price`);

      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

      // Map Yahoo trading period to readable Korean session badge
      let session = 'LIVE TICK';
      const nowSec = Math.floor(Date.now() / 1000);
      const tp = meta.currentTradingPeriod;
      if (tp) {
        if (tp.regular && nowSec >= tp.regular.start && nowSec <= tp.regular.end) {
          session = '정규장 LIVE';
        } else if (tp.pre && nowSec >= tp.pre.start && nowSec <= tp.pre.end) {
          session = '프리마켓 LIVE';
        } else if (tp.post && nowSec >= tp.post.start && nowSec <= tp.post.end) {
          session = '애프터 LIVE';
        }
      }

      return {
        price,
        prevClose,
        changePct: Number(changePct.toFixed(2)),
        session,
        source: `Yahoo v8 (${host.split('.')[0]})`,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Yahoo ${symbol} failed`);
}

module.exports = async function handler(req, res) {
  // Prevent browser & Vercel Edge CDN from caching stale prices
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  const finnhubKey = process.env.FINNHUB_API_KEY || '';

  const payload = {
    ok: false,
    updatedAt: new Date().toISOString(),
    sources: {
      tsm: null,
      tw2330: null,
      fx: null,
    },
    tsm: null,
    tw2330: null,
    fx: {
      usdKrw: null,
      usdTwd: null,
    },
  };

  // Run all upstream providers in parallel for lowest latency
  const [finnhubRes, yahooTsmRes, yahooTwRes, dunamuFxRes, yahooKrwRes, yahooTwdRes, erFxRes] =
    await Promise.allSettled([
      finnhubKey ? fetchFinnhubQuote('TSM', finnhubKey) : Promise.resolve(null),
      fetchYahooChart('TSM'),
      fetchYahooChart('2330.TW'),
      fetchDunamuFx(),
      fetchYahooChart('KRW=X'),
      fetchYahooChart('TWD=X'),
      fetchJson('https://open.er-api.com/v6/latest/USD', 3500),
    ]);

  // 1) TSM (NYSE ADR): Prefer Yahoo v8 during pre/after-hours or Finnhub during regular market
  const yahooTsm = yahooTsmRes.status === 'fulfilled' ? yahooTsmRes.value : null;
  const finnhubTsm =
    finnhubRes.status === 'fulfilled' && finnhubRes.value ? finnhubRes.value : null;

  if (finnhubTsm && (!yahooTsm || yahooTsm.session === '정규장 LIVE')) {
    payload.tsm = {
      price: finnhubTsm.price,
      changePct: finnhubTsm.changePct,
      session: finnhubTsm.session,
    };
    payload.sources.tsm = finnhubTsm.source;
  } else if (yahooTsm) {
    payload.tsm = {
      price: Number(yahooTsm.price.toFixed(2)),
      changePct: yahooTsm.changePct,
      session: yahooTsm.session,
    };
    payload.sources.tsm = yahooTsm.source;
  }

  // 2) 2330.TW (Taiwan Main Stock)
  if (yahooTwRes.status === 'fulfilled' && yahooTwRes.value) {
    payload.tw2330 = {
      price: Number(yahooTwRes.value.price.toFixed(2)),
      changePct: yahooTwRes.value.changePct,
    };
    payload.sources.tw2330 = yahooTwRes.value.source;
  }

  // 3) FX Rates: 1st Hana Bank (Dunamu) -> 2nd Yahoo Global FX -> 3rd open.er-api
  if (dunamuFxRes.status === 'fulfilled' && dunamuFxRes.value) {
    payload.fx.usdKrw = dunamuFxRes.value.usdKrw;
    payload.fx.usdTwd = dunamuFxRes.value.usdTwd;
    payload.sources.fx = dunamuFxRes.value.source;
  }

  if (!payload.fx.usdKrw && yahooKrwRes.status === 'fulfilled' && yahooKrwRes.value) {
    payload.fx.usdKrw = Number(yahooKrwRes.value.price.toFixed(2));
    payload.sources.fx = payload.sources.fx || 'Yahoo FX';
  }

  if (!payload.fx.usdTwd && yahooTwdRes.status === 'fulfilled' && yahooTwdRes.value) {
    payload.fx.usdTwd = Number(yahooTwdRes.value.price.toFixed(3));
    payload.sources.fx = payload.sources.fx || 'Yahoo FX';
  }

  if (erFxRes.status === 'fulfilled' && erFxRes.value?.rates) {
    if (!payload.fx.usdKrw && erFxRes.value.rates.KRW) {
      payload.fx.usdKrw = Number(erFxRes.value.rates.KRW);
      payload.sources.fx = payload.sources.fx || 'open.er-api';
    }
    if (!payload.fx.usdTwd && erFxRes.value.rates.TWD) {
      payload.fx.usdTwd = Number(erFxRes.value.rates.TWD);
      payload.sources.fx = payload.sources.fx || 'open.er-api';
    }
  }

  payload.ok = Boolean(payload.tsm || payload.tw2330 || payload.fx.usdKrw);

  return res.status(200).json(payload);
};
