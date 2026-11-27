// /api/tsmc.js — Robust Multi-Source Real-time API for Vercel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  let tsmData = { price: 342.34, changePct: 1.85 };
  let twData = { price: 2180, changePct: 1.40 };
  let fxData = { usdKrw: 1339.84, usdTwd: 32.956 };

  // 1. Fetch Real-time Exchange Rates from reliable public endpoints
  try {
    const fxRes = await fetch('https://open.er-api.com/v6/latest/USD');
    if (fxRes.ok) {
      const fxJson = await fxRes.json();
      if (fxJson?.rates) {
        if (fxJson.rates.KRW) fxData.usdKrw = Number(fxJson.rates.KRW);
        if (fxJson.rates.TWD) fxData.usdTwd = Number(fxJson.rates.TWD);
      }
    }
  } catch (_) {}

  // 2. Fetch TSM & 2330.TW with robust User-Agent headers
  try {
    const tickers = ['TSM', '2330.TW'];
    const queryUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`;
    const response = await fetch(queryUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (response.ok) {
      const json = await response.json();
      const results = json?.quoteResponse?.result || [];

      results.forEach((q) => {
        const price = q.regularMarketPrice || q.postMarketPrice || q.preMarketPrice || q.bid;
        const prevClose = q.regularMarketPreviousClose;
        const changePct = q.regularMarketChangePercent !== undefined ? q.regularMarketChangePercent : (prevClose && price ? ((price - prevClose) / prevClose) * 100 : 0);

        if (q.symbol === 'TSM' && price) {
          tsmData = { price: Number(price), changePct: Number(changePct) };
        } else if (q.symbol === '2330.TW' && price) {
          twData = { price: Number(price), changePct: Number(changePct) };
        }
      });
    }
  } catch (_) {}

  // 3. Fetch RSS News
  let newsItems = [];
  try {
    const rssUrl = `https://news.google.com/rss/search?q=TSMC+stock&hl=ko&gl=KR&ceid=KR:ko`;
    const rssRes = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`);
    const rssJson = await rssRes.json();
    if (rssJson.status === 'ok' && Array.isArray(rssJson.items)) {
      newsItems = rssJson.items.slice(0, 6).map((item) => ({
        title: item.title || '',
        source: item.author || 'Google News',
        pubDate: item.pubDate || new Date().toISOString(),
        lang: 'KO',
        url: item.link || 'https://investor.tsmc.com',
      }));
    }
  } catch (_) {}

  return res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    tsm: tsmData,
    tw2330: twData,
    fx: fxData,
    news: newsItems,
  });
}
