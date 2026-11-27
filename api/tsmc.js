// /api/tsmc.js — Vercel Serverless Function for Real-time TSM, 2330.TW, FX & News
export default async function handler(req, res) {
  // Allow CORS for browser fetch
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');

  try {
    // 1. Fetch TSM (US ADR), 2330.TW (Taiwan Stock) & FX Rates from Yahoo Finance API
    const tickers = ['TSM', '2330.TW', 'KRW=X', 'TWD=X'];
    const queryUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`;

    const response = await fetch(queryUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    let tsmData = { price: 342.34, changePct: 1.85 };
    let twData = { price: 2180, changePct: 1.40 };
    let fxData = { usdKrw: 1339.84, usdTwd: 32.956 };

    if (response.ok) {
      const json = await response.json();
      const results = json?.quoteResponse?.result || [];

      results.forEach((q) => {
        // Prioritize postMarket / preMarket / regular market prices for real-time overnight sync
        const price = q.postMarketPrice || q.preMarketPrice || q.regularMarketPrice;
        const prevClose = q.regularMarketPreviousClose;
        const changePct = prevClose && price ? ((price - prevClose) / prevClose) * 100 : (q.regularMarketChangePercent || 0);

        if (q.symbol === 'TSM') {
          if (price) tsmData = { price, changePct };
        } else if (q.symbol === '2330.TW') {
          if (price) twData = { price, changePct };
        } else if (q.symbol === 'KRW=X') {
          if (price) fxData.usdKrw = price;
        } else if (q.symbol === 'TWD=X') {
          if (price) fxData.usdTwd = price;
        }
      });
    }

    // 2. Fetch Live Google News RSS for TSMC
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
    } catch (_) {
      // Fallback handled on client
    }

    // 3. Return consolidated JSON response
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      tsm: tsmData,
      tw2330: twData,
      fx: fxData,
      news: newsItems,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      tsm: { price: 342.34, changePct: 1.85 },
      tw2330: { price: 2180, changePct: 1.40 },
      fx: { usdKrw: 1339.84, usdTwd: 32.956 },
    });
  }
}
