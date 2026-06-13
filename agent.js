require("dotenv").config();
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const RECIPIENT_EMAIL = "burnerwallet@gmail.com";
const FROM_EMAIL = process.env.GMAIL_USER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

// Curated universe — liquid, well-known stocks across all sectors
const UNIVERSE_BY_SECTOR = {
  "Technology":  ["NVDA","AAPL","MSFT","GOOGL","META","AMZN","AMD","AVGO","QCOM","INTC","MU","ADBE","CRM","ORCL","NOW","PLTR","ARM","MRVL"],
  "Financials":  ["JPM","GS","BAC","MS","V","MA","PYPL","COIN","SOFI"],
  "Healthcare":  ["LLY","UNH","JNJ","ABBV","PFE","MRNA","GILD","AMGN"],
  "Energy":      ["XOM","CVX","COP","SLB","OXY"],
  "Consumer":    ["NFLX","SBUX","NKE","TGT","WMT","HD","COST","MCD"],
  "Industrial":  ["CAT","HON","BA","GE","RTX","LMT"],
  "EV/Auto":     ["TSLA","F","GM","RIVN"],
};
const UNIVERSE = Object.values(UNIVERSE_BY_SECTOR).flat();
// Map ticker -> sector for later use
const TICKER_SECTOR = {};
Object.entries(UNIVERSE_BY_SECTOR).forEach(([sector, tickers]) => {
  tickers.forEach(t => { TICKER_SECTOR[t] = sector; });
});

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

async function fetchNews(ticker) {
  const data = await alpacaGet("/v1beta1/news?symbols=" + ticker + "&limit=3");
  if (!data || !data.news) return [];
  return data.news.map(function(n) {
    return n.headline + (n.summary ? " — " + n.summary : "");
  });
}

// ─── Alpaca API calls ─────────────────────────────────────────────────────────

async function alpacaGet(path) {
  const res = await fetch("https://data.alpaca.markets" + path, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    }
  });
  return res.json();
}

async function fetchMovers() {
  return alpacaGet("/v1beta1/screener/stocks/movers?top=50");
}

async function fetchMostActives() {
  return alpacaGet("/v1beta1/screener/stocks/most-actives?top=50");
}

async function fetchSnapshots(tickers) {
  const result = {};
  const BATCH = 100;
  for (var i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const data = await alpacaGet("/v2/stocks/snapshots?symbols=" + batch.join(","));
    if (data && !data.message) Object.assign(result, data);
    if (i + BATCH < tickers.length) await sleep(300);
  }
  return result;
}

// Fetch 1 year of daily bars to compute 52w high/low, 50d/200d moving averages
async function fetchBars(ticker) {
  return []; // Historical bars not available on free Alpaca plan
}

// ─── Compute technicals from bar history ──────────────────────────────────────

function computeTechnicals(bars) {
  if (!bars || bars.length < 2) return null;
  const closes = bars.map(function(b) { return b.c; });
  const high52  = Math.max.apply(null, closes);
  const low52   = Math.min.apply(null, closes);
  const ma50    = closes.length >= 50  ? closes.slice(-50).reduce(function(a,b){return a+b;},0)/50   : null;
  const ma200   = closes.length >= 200 ? closes.slice(-200).reduce(function(a,b){return a+b;},0)/200 : null;
  return { high52, low52, ma50, ma200 };
}

// ─── Score stock for selection (entry timing only, not recommendation) ────────

function scoreStock(snap, tech) {
  var score = 0;
  var reasons = [];

  var price     = snap.dailyBar.c;
  var prevClose = snap.prevDailyBar.c;
  var changePct = ((price - prevClose) / prevClose) * 100;
  var volume    = snap.dailyBar.v;
  var vwap      = snap.dailyBar.vw;
  var high      = snap.dailyBar.h;
  var low       = snap.dailyBar.l;
  var open      = snap.dailyBar.o;

  // 1. Notable price move today — used for selection, not recommendation (30 pts)
  var absPct = Math.abs(changePct);
  if (absPct > 10)     { score += 30; reasons.push((changePct > 0 ? "+" : "") + changePct.toFixed(1) + "% today"); }
  else if (absPct > 5) { score += 20; reasons.push((changePct > 0 ? "+" : "") + changePct.toFixed(1) + "% today"); }
  else if (absPct > 2) { score += 10; reasons.push((changePct > 0 ? "+" : "") + changePct.toFixed(1) + "% today"); }
  else                 { score += 3; }

  // 2. Volume (30 pts) — high volume = significant event worth analyzing
  if (volume > 50000000)      { score += 30; reasons.push("massive volume " + (volume/1e6).toFixed(0) + "M"); }
  else if (volume > 10000000) { score += 22; reasons.push("high volume " + (volume/1e6).toFixed(0) + "M"); }
  else if (volume > 2000000)  { score += 12; reasons.push("volume " + (volume/1e6).toFixed(1) + "M"); }
  else if (volume > 500000)   { score += 5; }

  // 3. Price vs VWAP (20 pts) — intraday conviction
  if (price > vwap)    { score += 20; reasons.push("above VWAP $" + vwap.toFixed(2)); }
  else                 { score += 5; }

  // 4. Intraday range position (20 pts)
  var dayRange = high - low;
  if (dayRange > 0) {
    var closePosition = (price - low) / dayRange;
    if (closePosition > 0.7)      { score += 20; reasons.push("closed near day high"); }
    else if (closePosition > 0.4) { score += 10; }
    else                          { score += 2; reasons.push("closed near day low"); }
  }

  // Avoid sub-$5 stocks (likely micro-cap pumps)
  if (price < 5) { score = Math.min(score, 20); }

  return { score: Math.min(score, 100), reasons };
}

// ─── Pick top stocks with sector diversification ──────────────────────────────

async function pickStocks() {
  console.log("Fetching snapshots for " + UNIVERSE.length + " stocks...");
  const snaps = await fetchSnapshots(UNIVERSE);
  console.log("Got " + Object.keys(snaps).length + " snapshots");

  // Score every stock regardless of direction
  const scored = [];
  const tickers = Object.keys(snaps);

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var snap = snaps[ticker];
    if (!snap || !snap.dailyBar || !snap.prevDailyBar || snap.dailyBar.c < 5) continue;

    var changePct = ((snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100;
    var result = scoreStock(snap, null);

    console.log("  " + ticker + " [" + (TICKER_SECTOR[ticker] || "?") + "] score:" + result.score + " " + (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%");

    scored.push({
      ticker, snap, news: [],
      sector: TICKER_SECTOR[ticker] || "Other",
      score: result.score,
      reasons: result.reasons,
      price: snap.dailyBar.c,
      prevClose: snap.prevDailyBar.c,
      changePct: changePct,
    });
  }

  // Sort all by score desc
  scored.sort(function(a, b) { return b.score - a.score; });

  // Pick best from each sector (max 1 per sector), up to 7 total
  var selected = [];
  var usedSectors = {};
  for (var j = 0; j < scored.length && selected.length < 7; j++) {
    var s = scored[j];
    if (!usedSectors[s.sector]) {
      usedSectors[s.sector] = true;
      selected.push(s);
    }
  }
  // Fill remaining slots up to 5 with highest-scoring remaining stocks
  for (var k = 0; k < scored.length && selected.length < 5; k++) {
    if (selected.indexOf(scored[k]) === -1) selected.push(scored[k]);
  }
  if (selected.length > 5) selected = selected.slice(0, 5);

  // Fetch news for selected stocks
  console.log("Fetching news for " + selected.length + " stocks...");
  for (var n = 0; n < selected.length; n++) {
    try {
      selected[n].news = await fetchNews(selected[n].ticker);
    } catch(e) {
      selected[n].news = [];
    }
    await sleep(100);
  }

  console.log("\nSelected: " + selected.map(function(s) {
    return s.ticker + "[" + s.sector + "](score:" + s.score + " " + (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(1) + "%)";
  }).join(" | "));

  return selected;
}

// ─── Analyze with Claude (Sonnet) ─────────────────────────────────────────────

async function analyzeStock(s) {
  console.log("Analyzing " + s.ticker + "...");

  var q  = s.snap.dailyBar;
  var pq = s.snap.prevDailyBar;
  var pct = "+" + s.changePct.toFixed(2) + "%";
  var gapPct = ((q.o - pq.c) / pq.c * 100).toFixed(2);
  var dayRange = q.h - q.l;
  var closePosition = dayRange > 0 ? ((q.c - q.l) / dayRange * 100).toFixed(0) : "N/A";

  var newsLines = s.news && s.news.length
    ? "Recent news:\n" + s.news.map(function(h, i) { return (i+1) + ". " + h; }).join("\n")
    : "Recent news: none found";

  var lines = [
    "Ticker: " + s.ticker,
    "Price: $" + q.c.toFixed(2) + " (" + pct + " today)",
    "Open: $" + q.o.toFixed(2) + " (gap from prev close: +" + gapPct + "%)",
    "High: $" + q.h.toFixed(2) + " | Low: $" + q.l.toFixed(2),
    "Close position in day range: " + closePosition + "% (100% = closed at high)",
    "VWAP: $" + q.vw.toFixed(2) + " | Price vs VWAP: " + (q.c > q.vw ? "ABOVE (bullish)" : "BELOW (bearish)"),
    "Volume: " + (q.v/1e6).toFixed(1) + "M",
    "Prev close: $" + pq.c.toFixed(2),
    "Signal score: " + s.score + "/100",
    "Key signals: " + s.reasons.join(", "),
    "",
    newsLines,
  ].join("\n");

  var prompt = "You are a fundamental equity analyst evaluating " + s.ticker + " (" + (s.sector || "unknown sector") + ") for a 6-12 month investment horizon. Here is today's market data and news:\n\n"
    + lines + "\n\n"
    + "Your job is to assess the LONG-TERM investment thesis, not just today's price move. Today's data is context for entry timing, not the primary signal.\n\n"
    + "Consider:\n"
    + "1. What is the business quality, competitive moat, and growth trajectory of this company?\n"
    + "2. Does today's news (if any) change the long-term thesis, or is it just short-term noise?\n"
    + "3. Is the stock attractively valued for a 6-12 month hold, or is it overextended?\n"
    + "4. Would you still hold this position if it dropped 10% next week?\n\n"
    + "Respond in EXACTLY this format:\n\n"
    + "Catalyst: [today's news/event if any, or 'No major catalyst — routine day']\n"
    + "Bull: [long-term bull case — business quality, growth drivers, competitive advantages]\n"
    + "Bear: [long-term bear risks — valuation, competition, execution risk, macro]\n"
    + "RECOMMENDATION: [BUY or HOLD or SELL]\n"
    + "Confidence: [HIGH or MEDIUM or LOW]\n"
    + "Target: $[realistic 12-month price target based on fundamentals, not momentum]\n"
    + "Entry: [buy now / wait for dip to $X-Y / avoid at current valuation]\n"
    + "Summary: [2 sentences: long-term thesis and why this is or isn't a good entry point]\n\n"
    + "RECOMMENDATION criteria:\n"
    + "BUY: Strong or improving business, not obviously overvalued, catalyst or momentum supports entry — this should be your default for quality companies\n"
    + "HOLD: Business is solid but valuation is stretched OR near-term headwinds outweigh the long-term case\n"
    + "SELL: Fundamental thesis is broken, valuation is extreme (e.g. 100x+ P/E with slowing growth), or serious red flag in the news\n"
    + "Use your knowledge of the company — ARM designs chips for AI/mobile, JPM is the leading US bank, WMT has dominant retail/e-commerce, UNH leads managed care, RIVN is an EV startup.\n"
    + "A move today on real news is a positive signal for entry. If the business is strong and the stock is moving on good news, that is a BUY.\n"
    + "Never write N/A. Be decisive.";

  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: "You are a fundamental equity analyst. Use your knowledge of each company's business model, competitive position, growth trajectory, and typical valuation to inform your recommendation — combined with today's market data and news. Your default for high-quality businesses at reasonable valuations should be BUY. HOLD means you genuinely cannot recommend buying right now. SELL means the thesis is broken or valuation is extreme. Do not default to HOLD out of caution — make a decisive call.",
      messages: [{ role: "user", content: prompt }],
    })
  });

  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  var text = (data.content.find(function(b) { return b.type === "text"; }) || {}).text || "";
  console.log("  " + s.ticker + " done");
  return { stock: s, analysis: text };
}

// ─── Parse fields ─────────────────────────────────────────────────────────────

function field(text, name) {
  var m = text.match(new RegExp("^" + name + "\\s*:\\s*(.+)$", "im"));
  return m ? m[1].trim().replace(/\*\*/g, "") : "—";
}

function rec(text) {
  var m = text.match(/^RECOMMENDATION\s*:\s*(BUY|HOLD|SELL)/im);
  return m ? m[1].toUpperCase() : "HOLD";
}

function recCol(r) {
  return { BUY: "#16a34a", HOLD: "#d97706", SELL: "#dc2626" }[r] || "#888";
}

function fmtVol(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n/1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n/1e3).toFixed(0) + "K";
  return "" + n;
}

// ─── Build email ──────────────────────────────────────────────────────────────

function buildEmail(results, date) {
  var buys = 0, holds = 0, sells = 0;
  results.forEach(function(r) {
    var v = rec(r.analysis);
    if (v === "BUY") buys++; else if (v === "SELL") sells++; else holds++;
  });

  var cards = results.map(function(r) {
    var s      = r.stock;
    var q      = s.snap.dailyBar;
    var t      = s.tech;
    var rv     = rec(r.analysis);
    var col    = recCol(rv);
    var pct    = "+" + s.changePct.toFixed(2) + "%";
    var bull    = field(r.analysis, "Bull");
    var bear    = field(r.analysis, "Bear");
    var conf    = field(r.analysis, "Confidence");
    var target  = field(r.analysis, "Target");
    var entry   = field(r.analysis, "Entry");
    var summary = field(r.analysis, "Summary");
    var scoreCol = s.score >= 65 ? "#16a34a" : s.score >= 45 ? "#d97706" : "#dc2626";

    return '<div style="margin-bottom:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04)">'

      // Header
      + '<div style="border-left:5px solid ' + col + ';padding:13px 18px;display:flex;align-items:center;gap:10px;background:' + col + '0d">'
      + '<span style="font-size:20px;font-weight:900;font-family:monospace;color:#0f172a">' + s.ticker + '</span>'
      + '<span style="background:' + col + ';color:#fff;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:1px">' + rv + '</span>'
      + '<div style="margin-left:auto;text-align:right">'
      + '<div style="font-size:18px;font-weight:800;color:#0f172a">$' + q.c.toFixed(2) + '</div>'
      + '<div style="font-size:12px;font-weight:700;color:#16a34a">' + pct + ' today</div>'
      + '</div>'
      + '</div>'

      // Price metrics bar
      + '<div style="background:#f8fafc;border-bottom:1px solid #e2e8f0;padding:7px 18px;display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:#64748b">'
      + '<span>Open <b style="color:#1e293b">$' + q.o.toFixed(2) + '</b></span>'
      + '<span>High <b style="color:#1e293b">$' + q.h.toFixed(2) + '</b></span>'
      + '<span>Low <b style="color:#1e293b">$' + q.l.toFixed(2) + '</b></span>'
      + '<span>VWAP <b style="color:#1e293b">$' + q.vw.toFixed(2) + '</b></span>'
      + '<span>Vol <b style="color:#1e293b">' + fmtVol(q.v) + '</b></span>'
      + '</div>'

      // Technical bar
      + (t ? (
        '<div style="background:#f0f7ff;border-bottom:1px solid #e2e8f0;padding:7px 18px;display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:#64748b">'
        + '<span>52W Low <b style="color:#1e293b">$' + t.low52.toFixed(2) + '</b></span>'
        + '<span>52W High <b style="color:#1e293b">$' + t.high52.toFixed(2) + '</b></span>'
        + (t.ma50  ? '<span>50d MA <b style="color:' + (q.c > t.ma50  ? "#16a34a":"#dc2626") + '">$' + t.ma50.toFixed(2)  + '</b></span>' : '')
        + (t.ma200 ? '<span>200d MA <b style="color:' + (q.c > t.ma200 ? "#16a34a":"#dc2626") + '">$' + t.ma200.toFixed(2) + '</b></span>' : '')
        + '</div>'
      ) : '')

      // Score bar
      + '<div style="padding:7px 18px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px">'
      + '<span style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">Signal Score</span>'
      + '<div style="flex:1;background:#e2e8f0;border-radius:4px;height:6px">'
      + '<div style="width:' + s.score + '%;background:' + scoreCol + ';border-radius:4px;height:6px"></div>'
      + '</div>'
      + '<span style="font-size:11px;font-weight:700;color:' + scoreCol + '">' + s.score + '/100</span>'
      + '</div>'

      // Analysis
      + '<div style="padding:13px 18px">'
      + (field(r.analysis, "Catalyst") !== "—" ? '<div style="margin-bottom:10px;padding:8px 11px;background:#fefce8;border-left:3px solid #ca8a04;border-radius:6px;font-size:12px;color:#854d0e"><strong>⚡ Catalyst:</strong> ' + field(r.analysis, "Catalyst") + '</div>' : '')
      + '<div style="display:flex;gap:10px;margin-bottom:10px">'
      + '<div style="flex:1;background:#f0fdf4;border-radius:7px;padding:9px 11px;font-size:12px;color:#15803d;line-height:1.5"><strong>▲ Bull</strong><br>' + bull + '</div>'
      + '<div style="flex:1;background:#fef2f2;border-radius:7px;padding:9px 11px;font-size:12px;color:#b91c1c;line-height:1.5"><strong>▼ Bear</strong><br>' + bear + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:20px;font-size:12px;color:#64748b;margin-bottom:9px">'
      + '<span>Confidence: <strong style="color:#0f172a">' + conf + '</strong></span>'
      + '<span>12M Target: <strong style="color:#0f172a">' + target + '</strong></span>'
      + '<span>Entry: <strong style="color:#0f172a">' + entry + '</strong></span>'
      + '</div>'
      + '<div style="padding:9px 11px;background:#f8fafc;border-left:3px solid ' + col + ';border-radius:6px;font-size:12px;color:#334155;line-height:1.5">' + summary + '</div>'
      + '</div></div>';
  }).join("");

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">'
    + '<div style="max-width:640px;margin:0 auto;padding:22px 14px">'

    + '<div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);border-radius:13px;padding:24px;margin-bottom:16px;text-align:center">'
    + '<div style="font-size:10px;letter-spacing:3px;color:#475569;text-transform:uppercase;margin-bottom:4px">Daily Market Intelligence</div>'
    + '<div style="font-size:27px;font-weight:900;color:#fff;letter-spacing:-0.5px">ALPHA AGENT</div>'
    + '<div style="margin-top:4px;font-size:12px;color:#94a3b8">' + date + '</div>'
    + '<div style="margin-top:3px;font-size:10px;color:#475569">Top picks across all sectors · Fundamental 6-12 month outlook · Data: Alpaca</div>'
    + '</div>'

    + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:14px 20px;margin-bottom:16px">'
    + '<div style="display:flex;justify-content:space-around;text-align:center;margin-bottom:8px">'
    + '<div><div style="font-size:26px;font-weight:900;color:#16a34a">' + buys  + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Buy</div></div>'
    + '<div style="width:1px;background:#e2e8f0"></div>'
    + '<div><div style="font-size:26px;font-weight:900;color:#d97706">' + holds + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Hold</div></div>'
    + '<div style="width:1px;background:#e2e8f0"></div>'
    + '<div><div style="font-size:26px;font-weight:900;color:#dc2626">' + sells + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Sell</div></div>'
    + '</div>'
    + '<div style="font-size:10px;color:#94a3b8;text-align:center">One pick per sector · Fundamental long-term thesis · Daily data used for entry timing only</div>'
    + '</div>'

    + cards

    + '<div style="text-align:center;padding:12px;font-size:10px;color:#94a3b8;line-height:1.7">'
    + 'AI research only — not financial advice. Always do your own due diligence.<br>'
    + '<strong>Alpha Agent</strong> · Claude Sonnet + Alpaca Markets'
    + '</div></div></body></html>';
}

// ─── Send email ───────────────────────────────────────────────────────────────

async function sendEmail(html, date) {
  var t = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await t.sendMail({
    from: '"Alpha Agent" <' + FROM_EMAIL + '>',
    to: RECIPIENT_EMAIL,
    subject: "Alpha Agent Daily Digest — " + date,
    html: html,
  });
  console.log("Email sent to " + RECIPIENT_EMAIL);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDailyResearch() {
  var date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  console.log("\nAlpha Agent starting — " + date);
  try {
    var stocks = await pickStocks();
    if (!stocks.length) { console.log("No stocks selected today."); return; }
    var results = [];
    for (var i = 0; i < stocks.length; i++) {
      if (i > 0) await sleep(1000);
      results.push(await analyzeStock(stocks[i]));
    }
    await sendEmail(buildEmail(results, date), date);
    console.log("Done!");
  } catch(err) {
    console.error("Error:", err.message);
    console.error(err.stack);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
cron.schedule("30 7 * * 1-5", function() { runDailyResearch(); }, { timezone: "America/New_York" });
console.log("Alpha Agent scheduled — runs weekdays at 7:30am ET");
console.log("To run now: node agent.js --now\n");
if (process.argv.indexOf("--now") !== -1) { runDailyResearch(); }
