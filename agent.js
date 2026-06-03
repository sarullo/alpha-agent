require("dotenv").config();
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const RECIPIENT_EMAIL = "burnerwallet@gmail.com";
const FROM_EMAIL = process.env.GMAIL_USER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

// Curated universe — liquid, well-known stocks across all sectors
const UNIVERSE = [
  // Mega-cap tech
  "NVDA","AAPL","MSFT","GOOGL","META","AMZN","TSLA","AMD","AVGO","QCOM",
  "INTC","MU","ADBE","CRM","ORCL","NOW","PLTR","SMCI","ARM","MRVL",
  // Financials
  "JPM","GS","BAC","MS","V","MA","PYPL","HOOD","COIN","SOFI",
  // Healthcare
  "LLY","UNH","JNJ","ABBV","PFE","MRNA","GILD","AMGN",
  // Energy
  "XOM","CVX","COP","SLB","OXY",
  // Consumer / Retail
  "NFLX","SBUX","NKE","TGT","WMT","HD","COST",
  // Industrial / Other
  "CAT","HON","BA","GE","F","GM","UBER","ABNB"
];

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

// ─── Score stock using only Alpaca data ───────────────────────────────────────

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

  // 1. Momentum today (40 pts)
  if (changePct > 20)      { score += 40; reasons.push("surged +" + changePct.toFixed(1) + "% today"); }
  else if (changePct > 10) { score += 32; reasons.push("up +" + changePct.toFixed(1) + "% today"); }
  else if (changePct > 5)  { score += 22; reasons.push("up +" + changePct.toFixed(1) + "% today"); }
  else if (changePct > 2)  { score += 12; reasons.push("up +" + changePct.toFixed(1) + "% today"); }
  else if (changePct > 0)  { score += 4; }

  // 2. Price vs VWAP (15 pts) — above VWAP = buyers in control all day
  if (price > vwap)        { score += 15; reasons.push("above VWAP $" + vwap.toFixed(2)); }

  // 3. Intraday strength — close near high of day (20 pts)
  var dayRange = high - low;
  if (dayRange > 0) {
    var closePosition = (price - low) / dayRange; // 1.0 = closed at high, 0 = at low
    if (closePosition > 0.8)      { score += 20; reasons.push("closing near day high"); }
    else if (closePosition > 0.6) { score += 12; reasons.push("strong close"); }
    else if (closePosition > 0.4) { score += 5; }
  }

  // 4. Gap up from open (10 pts) — strong open = gap up catalyst
  var gapPct = ((open - prevClose) / prevClose) * 100;
  if (gapPct > 10)      { score += 10; reasons.push("gapped up +" + gapPct.toFixed(1) + "%"); }
  else if (gapPct > 5)  { score += 7; reasons.push("gapped up +" + gapPct.toFixed(1) + "%"); }
  else if (gapPct > 2)  { score += 4; }

  // 5. Volume (15 pts)
  if (volume > 50000000)      { score += 15; reasons.push("massive volume " + (volume/1e6).toFixed(0) + "M"); }
  else if (volume > 10000000) { score += 10; reasons.push("high volume " + (volume/1e6).toFixed(0) + "M"); }
  else if (volume > 2000000)  { score += 6; reasons.push("volume " + (volume/1e6).toFixed(1) + "M"); }
  else if (volume > 500000)   { score += 3; }

  // 6. Price sanity — avoid sub-$10 stocks with crazy % moves (likely pumps)
  if (price < 10 && changePct > 30) { score = Math.min(score, 25); }

  return { score: Math.min(score, 100), reasons };
}

// ─── Pick top 5 stocks ────────────────────────────────────────────────────────

async function pickStocks() {
  console.log("Fetching snapshots for " + UNIVERSE.length + " stocks...");
  const snaps = await fetchSnapshots(UNIVERSE);
  console.log("Got " + Object.keys(snaps).length + " snapshots");

  // Score each stock
  const scored = [];
  const tickers = Object.keys(snaps);

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var snap = snaps[ticker];
    if (!snap || !snap.dailyBar || !snap.prevDailyBar || snap.dailyBar.c < 5) continue;

    var changePct = ((snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100;
    if (changePct <= 0) continue; // only upward momentum

    var result = scoreStock(snap, null);

    console.log("  " + ticker + " score:" + result.score + " +" + changePct.toFixed(2) + "% | " + result.reasons.slice(0,3).join(", "));

    scored.push({
      ticker, snap, news: [],
      score: result.score,
      reasons: result.reasons,
      price: snap.dailyBar.c,
      prevClose: snap.prevDailyBar.c,
      changePct: changePct,
    });
  }

  // Fetch news for all scored stocks, filter to those with news today
  console.log("Fetching news for " + scored.length + " stocks...");
  for (var n = 0; n < scored.length; n++) {
    try {
      scored[n].news = await fetchNews(scored[n].ticker);
    } catch(e) {
      scored[n].news = [];
    }
    await sleep(100);
  }

  // Separate into stocks with news vs without
  const withNews    = scored.filter(function(s) { return s.news && s.news.length > 0; });
  const withoutNews = scored.filter(function(s) { return !s.news || s.news.length === 0; });

  // Sort each group by score desc, price desc
  function sortStocks(arr) {
    arr.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.price - a.price;
    });
  }
  sortStocks(withNews);
  sortStocks(withoutNews);

  // Pick top 5 — prefer stocks with news, fill with no-news only if needed
  var pool = withNews.concat(withoutNews);
  var top5 = pool.slice(0, 5);

  console.log("\nSelected: " + top5.map(function(s) {
    return s.ticker + "(score:" + s.score + " +" + s.changePct.toFixed(1) + "% news:" + (s.news.length > 0 ? "yes" : "no") + ")";
  }).join(" | "));

  return top5;
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

  var prompt = "You are analyzing " + s.ticker + " as a professional equity analyst. Here is today's data including news:\n\n"
    + lines + "\n\n"
    + "Based on this data:\n"
    + "1. What is the PRIMARY catalyst? Check news for: earnings beats, analyst upgrades/downgrades, price target changes, product launches, partnerships, FDA approvals, macro events.\n"
    + "2. If you see an analyst upgrade/downgrade in the news, call out the firm name, new rating, and price target explicitly.\n"
    + "3. Is this a real fundamental catalyst or speculation/pump?\n"
    + "4. What is a realistic 12-month target and good entry price?\n\n"
    + "Respond in EXACTLY this format:\n\n"
    + "Catalyst: [what is actually driving the move today, from the news]\n"
    + "Bull: [specific bull case using actual numbers and news catalyst]\n"
    + "Bear: [specific risk using actual numbers]\n"
    + "RECOMMENDATION: [BUY or HOLD or SELL]\n"
    + "Confidence: [HIGH or MEDIUM or LOW]\n"
    + "Target: $[12-month price estimate]\n"
    + "Entry: [current $X or wait for dip to $X]\n"
    + "Summary: [2 sentences on catalyst and recommendation]\n\n"
    + "BUY if: score 40+, above VWAP, closed near day high. A stock up 5%+ with news is almost always a BUY.\n"
    + "HOLD if: score below 40, or stock is up less than 2% with no clear catalyst.\n"
    + "SELL if: below VWAP with no catalyst and score below 25.\n"
    + "Important: these stocks were pre-selected because they are moving today. Default to BUY for strong movers with news. Only say HOLD if you have a specific reason not to buy.\n"
    + "Never write N/A. Use actual numbers and reference the news.";

  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: "You are an aggressive growth-oriented equity analyst. These stocks have been pre-screened as today's top movers from a curated list of quality companies. Your job is to identify BUY opportunities. A stock up 5%+ on real news with strong intraday action is a BUY — say so clearly. Only say HOLD when signals are genuinely mixed. Only say SELL when there is a clear negative catalyst. Do not be overly cautious — these are quality companies moving for real reasons.",
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
    + '<div style="margin-top:3px;font-size:10px;color:#475569">Top 5 gainers · Scored on momentum, volume, MAs, 52-week position · Data: Alpaca</div>'
    + '</div>'

    + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:14px 20px;margin-bottom:16px">'
    + '<div style="display:flex;justify-content:space-around;text-align:center;margin-bottom:8px">'
    + '<div><div style="font-size:26px;font-weight:900;color:#16a34a">' + buys  + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Buy</div></div>'
    + '<div style="width:1px;background:#e2e8f0"></div>'
    + '<div><div style="font-size:26px;font-weight:900;color:#d97706">' + holds + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Hold</div></div>'
    + '<div style="width:1px;background:#e2e8f0"></div>'
    + '<div><div style="font-size:26px;font-weight:900;color:#dc2626">' + sells + '</div><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Sell</div></div>'
    + '</div>'
    + '<div style="font-size:10px;color:#94a3b8;text-align:center">Scoring: momentum + volume + moving averages + 52-week position</div>'
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
