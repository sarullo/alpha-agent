// Load .env only if running locally (GitHub Actions provides env vars directly)
try { require("dotenv").config(); } catch(e) {}
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const RECIPIENT_EMAIL = "burnerwallet@gmail.com";
const FROM_EMAIL = process.env.GMAIL_USER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ─── Fetch BTC price history from Blockchain.info ─────────────────────────────

async function fetchPriceHistory(timespan) {
  const url = "https://api.blockchain.info/charts/market-price?timespan=" + timespan + "&format=json&sampled=false";
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error("No price data returned");
  return data.values; // [{x: timestamp, y: price}]
}

// ─── Fetch current BTC price ──────────────────────────────────────────────────

async function fetchCurrentPrice() {
  const res = await fetch("https://api.blockchain.info/ticker");
  const data = await res.json();
  return data.USD.last;
}

// ─── Fetch Fear & Greed Index ─────────────────────────────────────────────────

async function fetchFearGreed() {
  const res = await fetch("https://api.alternative.me/fng/?limit=30");
  const data = await res.json();
  if (!data.data) return null;
  const current = data.data[0];
  const avg7d = data.data.slice(0, 7).reduce(function(a, b) { return a + parseInt(b.value); }, 0) / 7;
  const avg30d = data.data.slice(0, 30).reduce(function(a, b) { return a + parseInt(b.value); }, 0) / 30;
  return {
    value: parseInt(current.value),
    classification: current.value_classification,
    avg7d: avg7d.toFixed(1),
    avg30d: avg30d.toFixed(1),
  };
}



function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / period;
}

function computeIndicators(prices) {
  const closes = prices.map(function(p) { return p.y; });
  const now = closes[closes.length - 1];

  // SMAs
  const sma20   = sma(closes, 20);
  const sma50   = sma(closes, 50);
  const sma100  = sma(closes, 100);
  const sma200  = sma(closes, 200);
  const sma350  = sma(closes, 350);  // ~1 year
  const sma1458 = sma(closes, 1458); // 4 years (the "1458 SMA" = Pi Cycle indicator base)

  // 200 Week MA — sample every 7 days
  const weekly = [];
  for (var i = 0; i < closes.length; i += 7) {
    weekly.push(closes[i]);
  }
  const ma200w = sma(weekly, 200);

  // Pi Cycle Top Indicator: 111 DMA vs 350 DMA x2
  const sma111  = sma(closes, 111);
  const sma350x2 = sma350 ? sma350 * 2 : null;
  const piCycleTop = sma111 && sma350x2 ? sma111 >= sma350x2 * 0.98 : false; // within 2% = danger zone

  // Mayer Multiple: price / 200 DMA
  const mayerMultiple = sma200 ? now / sma200 : null;

  // 52-week high/low
  const last365 = closes.slice(-365);
  const high52w = Math.max.apply(null, last365);
  const low52w  = Math.min.apply(null, last365);
  const pctFrom52wHigh = ((high52w - now) / high52w) * 100;
  const pctFrom52wLow  = ((now - low52w) / low52w) * 100;

  // Realized price proxy: 200 DMA as rough proxy (actual realized price needs UTXO data)
  // Market vs 200 DMA ratio
  const mvrvProxy = sma200 ? now / sma200 : null;

  // Price vs 1458 SMA ratio (key cycle indicator)
  const priceVs1458 = sma1458 ? now / sma1458 : null;

  // Trend: consecutive days above/below 200 DMA
  let daysAbove200 = 0;
  for (var j = closes.length - 1; j >= 0; j--) {
    if (sma200 && closes[j] > sma200) daysAbove200++;
    else break;
  }

  // Recent momentum
  const price30dAgo  = closes.length >= 30  ? closes[closes.length - 30]  : null;
  const price90dAgo  = closes.length >= 90  ? closes[closes.length - 90]  : null;
  const price365dAgo = closes.length >= 365 ? closes[closes.length - 365] : null;

  const return30d  = price30dAgo  ? ((now - price30dAgo)  / price30dAgo)  * 100 : null;
  const return90d  = price90dAgo  ? ((now - price90dAgo)  / price90dAgo)  * 100 : null;
  const return365d = price365dAgo ? ((now - price365dAgo) / price365dAgo) * 100 : null;

  // Halving cycle context
  // Bitcoin halvings: Nov 2012, Jul 2016, May 2020, Apr 2024
  // Next halving: ~Apr 2028
  const lastHalving = new Date("2024-04-19");
  const nextHalving = new Date("2028-04-01");
  const now_date = new Date();
  const daysSinceHalving = Math.floor((now_date - lastHalving) / (1000 * 60 * 60 * 24));
  const daysToNextHalving = Math.floor((nextHalving - now_date) / (1000 * 60 * 60 * 24));
  const cycleProgress = daysSinceHalving / (daysSinceHalving + daysToNextHalving);

  return {
    currentPrice: now,
    sma20, sma50, sma100, sma200, sma350, sma1458,
    ma200w,
    sma111, sma350x2,
    piCycleTop,
    mayerMultiple,
    mvrvProxy,
    priceVs1458,
    high52w, low52w,
    pctFrom52wHigh, pctFrom52wLow,
    daysAbove200,
    return30d, return90d, return365d,
    daysSinceHalving, daysToNextHalving, cycleProgress,
  };
}

// ─── Analyze with Claude ──────────────────────────────────────────────────────

async function analyzeBTC(ind, fg) {
  const fmt = function(n, decimals) {
    if (n === null || n === undefined) return "N/A";
    return parseFloat(n).toFixed(decimals !== undefined ? decimals : 2);
  };
  const fmtPrice = function(n) { return n ? "$" + Math.round(n).toLocaleString() : "N/A"; };
  const fmtPct = function(n) { return n !== null ? (n >= 0 ? "+" : "") + fmt(n, 1) + "%" : "N/A"; };

  const fgSection = fg ? [
    "",
    "=== FEAR & GREED INDEX ===",
    "Current: " + fg.value + "/100 — " + fg.classification,
    "7-day average: " + fg.avg7d,
    "30-day average: " + fg.avg30d,
    "  < 20 = Extreme Fear (historically strong buy zone)",
    "  20-40 = Fear (good accumulation zone)",
    "  40-60 = Neutral",
    "  60-80 = Greed (start reducing)",
    "  > 80 = Extreme Greed (historically sell zone)",
  ].join("\n") : "";

  const dataBlock = [
    "=== CURRENT PRICE ===",
    "Bitcoin price: " + fmtPrice(ind.currentPrice),
    "30d return: " + fmtPct(ind.return30d),
    "90d return: " + fmtPct(ind.return90d),
    "1y return: " + fmtPct(ind.return365d),
    "",
    "=== MOVING AVERAGES ===",
    "20 DMA:   " + fmtPrice(ind.sma20)   + " | price is " + (ind.currentPrice > ind.sma20   ? "ABOVE" : "BELOW"),
    "50 DMA:   " + fmtPrice(ind.sma50)   + " | price is " + (ind.currentPrice > ind.sma50   ? "ABOVE" : "BELOW"),
    "100 DMA:  " + fmtPrice(ind.sma100)  + " | price is " + (ind.currentPrice > ind.sma100  ? "ABOVE" : "BELOW"),
    "200 DMA:  " + fmtPrice(ind.sma200)  + " | price is " + (ind.currentPrice > ind.sma200  ? "ABOVE" : "BELOW"),
    "200 WMA:  " + fmtPrice(ind.ma200w)  + " | price is " + (ind.currentPrice > ind.ma200w  ? "ABOVE" : "BELOW") + " (below = generational buy)",
    "350 DMA:  " + fmtPrice(ind.sma350),
    "1458 DMA: " + fmtPrice(ind.sma1458) + " | price/1458 SMA ratio: " + fmt(ind.priceVs1458, 2) + "x (>4x = euphoria, <1x = deep value)",
    "",
    "=== KEY INDICATORS ===",
    "Mayer Multiple (price/200DMA): " + fmt(ind.mayerMultiple, 2) + "x",
    "  < 0.8 = deep value — historically best buy zone",
    "  0.8-1.0 = good value — accumulate carefully",
    "  1.0-1.5 = fair value — hold",
    "  1.5-2.4 = elevated — reduce exposure",
    "  > 2.4 = historically overheated — take profits",
    "",
    "Pi Cycle Top (111 DMA vs 350 DMA x2):",
    "  111 DMA: " + fmtPrice(ind.sma111),
    "  350 DMA x2: " + fmtPrice(ind.sma350x2),
    "  Status: " + (ind.piCycleTop ? "⚠️ DANGER ZONE — top signal active" : "Not triggered — no top signal"),
    "",
    "Price vs 1458 DMA: " + fmt(ind.priceVs1458, 2) + "x",
    "52-week high: " + fmtPrice(ind.high52w) + " (" + fmt(ind.pctFrom52wHigh, 1) + "% below)",
    "52-week low:  " + fmtPrice(ind.low52w)  + " (" + fmt(ind.pctFrom52wLow, 1) + "% above)",
    fgSection,
    "",
    "=== HALVING CYCLE ===",
    "Last halving: April 19, 2024",
    "Days since halving: " + ind.daysSinceHalving + " days",
    "Days to next halving (~Apr 2028): " + ind.daysToNextHalving + " days",
    "Cycle progress: " + fmt(ind.cycleProgress * 100, 0) + "%",
    "Current month post-halving: " + Math.floor(ind.daysSinceHalving / 30),
    "  Months 1-6:   Accumulation phase — historically good entry",
    "  Months 6-18:  Bull run building — hold and add on dips",
    "  Months 18-24: Peak zone — start taking profits",
    "  Months 24-36: Post-peak — reduce exposure, bear market likely",
    "  Months 36-48: Bear bottom — best accumulation opportunity",
  ].join("\n");

  const prompt = "You are a Bitcoin analyst specializing in on-chain metrics and cycle analysis. Here is today's complete Bitcoin data:\n\n"
    + dataBlock + "\n\n"
    + "Analyze this data comprehensively. Consider ALL indicators together — not just one.\n\n"
    + "Respond in EXACTLY this format:\n\n"
    + "Cycle: [where we are in the 4-year cycle and what history says happens next]\n"
    + "MayerMultiple: [interpretation with specific number]\n"
    + "MA200Week: [interpretation — buy zone, danger zone, or neutral]\n"
    + "PiCycle: [status and what it means]\n"
    + "SMA1458: [interpretation of ratio]\n"
    + "FearGreed: [interpretation of current reading and what it signals]\n"
    + "BullTarget: $[realistic cycle top target if still in bull, or recovery target if bear]\n"
    + "SupportLevel: $[key support if price drops]\n"
    + "SIGNAL: [STRONG BUY or BUY or HOLD or TAKE PROFITS or SELL]\n"
    + "Confidence: [HIGH or MEDIUM or LOW]\n"
    + "Timeline: [specific advice — when to buy more, when to take profits]\n"
    + "Summary: [3 sentences — cycle position, what indicators say collectively, actionable advice]\n\n"
    + "SIGNAL criteria — use ALL indicators together:\n"
    + "STRONG BUY: Mayer < 0.8 AND Fear&Greed < 20 AND price near/below 200 WMA\n"
    + "BUY: Mayer < 1.0 AND Fear&Greed < 40 AND cycle months 1-20 AND Pi Cycle not triggered\n"
    + "HOLD: Mayer 1.0-1.5 OR cycle months 20-30 with mixed signals\n"
    + "TAKE PROFITS: Mayer > 1.5 AND cycle months 18+ AND Fear&Greed > 70\n"
    + "SELL: Pi Cycle Top triggered OR Mayer > 2.4 OR Fear&Greed > 85\n"
    + "Note: Extreme Fear (<20) at late cycle (month 26) = conflicting signal, use HOLD not BUY\n"
    + "Never write N/A. Be specific about what the combination of indicators tells you.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "You are a Bitcoin cycle analyst with deep expertise in on-chain metrics, halving cycles, and technical indicators specific to Bitcoin. You understand the Mayer Multiple, Pi Cycle Top, 200 Week MA, and 1458 SMA indicators deeply. Give clear, specific, actionable analysis based on where we are in the 4-year cycle.",
      messages: [{ role: "user", content: prompt }],
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.content.find(function(b) { return b.type === "text"; }) || {}).text || "";
}

// ─── Parse fields ─────────────────────────────────────────────────────────────

function field(text, name) {
  const m = text.match(new RegExp("^" + name + "\\s*:\\s*(.+)$", "im"));
  return m ? m[1].trim().replace(/\*\*/g, "") : "—";
}

function signal(text) {
  const m = text.match(/^SIGNAL\s*:\s*(STRONG BUY|BUY|HOLD|TAKE PROFITS|SELL)/im);
  return m ? m[1].toUpperCase() : "HOLD";
}

function signalColor(s) {
  return {
    "STRONG BUY":   "#16a34a",
    "BUY":          "#22c55e",
    "HOLD":         "#d97706",
    "TAKE PROFITS": "#ea580c",
    "SELL":         "#dc2626",
  }[s] || "#888";
}

function signalBg(s) {
  return {
    "STRONG BUY":   "#f0fdf4",
    "BUY":          "#f0fdf4",
    "HOLD":         "#fffbeb",
    "TAKE PROFITS": "#fff7ed",
    "SELL":         "#fef2f2",
  }[s] || "#f8fafc";
}

// ─── Build email ──────────────────────────────────────────────────────────────

function buildEmail(ind, fg, analysis, date) {
  const fmt = function(n, d) { return (n !== null && n !== undefined) ? parseFloat(n).toFixed(d || 2) : "N/A"; };
  const fmtPrice = function(n) { return n ? "$" + Math.round(n).toLocaleString() : "N/A"; };
  const sig = signal(analysis);
  const col = signalColor(sig);
  const bg  = signalBg(sig);

  const indicators = [
    { label: "Price",         value: fmtPrice(ind.currentPrice) },
    { label: "Mayer Multiple",value: fmt(ind.mayerMultiple) + "x" },
    { label: "200 WMA",       value: fmtPrice(ind.ma200w) },
    { label: "1458 SMA",      value: fmtPrice(ind.sma1458) },
    { label: "Price/1458 SMA",value: fmt(ind.priceVs1458) + "x" },
    { label: "200 DMA",       value: fmtPrice(ind.sma200) },
    { label: "Pi Cycle Top",  value: ind.piCycleTop ? "⚠️ TRIGGERED" : "✅ Not triggered" },
    { label: "52W High",      value: fmtPrice(ind.high52w) },
    { label: "52W Low",       value: fmtPrice(ind.low52w) },
    { label: "30d Return",    value: (ind.return30d >= 0 ? "+" : "") + fmt(ind.return30d, 1) + "%" },
    { label: "1Y Return",     value: (ind.return365d >= 0 ? "+" : "") + fmt(ind.return365d, 1) + "%" },
    { label: "Fear & Greed",    value: fg ? fg.value + "/100 — " + fg.classification : "N/A" },
    { label: "F&G 7d Avg",      value: fg ? fg.avg7d : "N/A" },
    { label: "F&G 30d Avg",     value: fg ? fg.avg30d : "N/A" },
  ].map(function(item) {
    return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px">'
      + '<span style="color:#64748b">' + item.label + '</span>'
      + '<span style="font-weight:700;color:#0f172a">' + item.value + '</span>'
      + '</div>';
  }).join("");

  const rows = [
    ["Cycle Position",  field(analysis, "Cycle")],
    ["Mayer Multiple",  field(analysis, "MayerMultiple")],
    ["200 Week MA",     field(analysis, "MA200Week")],
    ["Pi Cycle Top",    field(analysis, "PiCycle")],
    ["1458 SMA",        field(analysis, "SMA1458")],
    ["Fear & Greed",    field(analysis, "FearGreed")],
    ["Support Level",   field(analysis, "SupportLevel")],
    ["Timeline",        field(analysis, "Timeline")],
  ].map(function(row) {
    return '<tr>'
      + '<td style="padding:8px 12px;font-size:12px;color:#64748b;white-space:nowrap;vertical-align:top;width:130px"><strong>' + row[0] + '</strong></td>'
      + '<td style="padding:8px 12px;font-size:12px;color:#334155;line-height:1.5">' + row[1] + '</td>'
      + '</tr>';
  }).join("");

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">'
    + '<div style="max-width:640px;margin:0 auto;padding:22px 14px">'

    // Header
    + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);border-radius:14px;padding:28px;margin-bottom:16px;text-align:center;border:1px solid #f7931a30">'
    + '<div style="font-size:10px;letter-spacing:4px;color:#f7931a80;text-transform:uppercase;margin-bottom:6px">Bitcoin Cycle Intelligence</div>'
    + '<div style="font-size:32px;font-weight:900;color:#f7931a;letter-spacing:-1px">₿ BITCOIN AGENT</div>'
    + '<div style="margin-top:6px;font-size:12px;color:#64748b">' + date + '</div>'
    + '<div style="margin-top:16px;display:inline-block;background:' + col + ';color:#fff;padding:8px 24px;border-radius:30px;font-size:15px;font-weight:900;letter-spacing:2px">' + sig + '</div>'
    + '<div style="margin-top:8px;font-size:11px;color:#475569">Confidence: ' + field(analysis, "Confidence") + '</div>'
    + '</div>'

    // Summary
    + '<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px 20px;margin-bottom:16px;border-left:4px solid ' + col + '">'
    + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;margin-bottom:8px">Analysis</div>'
    + '<div style="font-size:13px;color:#cbd5e1;line-height:1.7">' + field(analysis, "Summary") + '</div>'
    + '</div>'

    // Indicators grid
    + '<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px 20px;margin-bottom:16px">'
    + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;margin-bottom:12px">Key Metrics</div>'
    + indicators
    + '</div>'

    // Indicator analysis table
    + '<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;margin-bottom:16px">'
    + '<div style="padding:12px 20px;border-bottom:1px solid #2a2a2a">'
    + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#f7931a">Indicator Breakdown</div>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse">' + rows + '</table>'
    + '</div>'

    // Footer
    + '<div style="text-align:center;padding:12px;font-size:10px;color:#374151;line-height:1.7">'
    + 'Bitcoin cycle analysis for educational purposes only. Not financial advice.<br>'
    + 'Data: Blockchain.info · Analysis: Claude Sonnet · <strong style="color:#f7931a">Bitcoin Agent</strong>'
    + '</div></div></body></html>';
}

// ─── Send email ───────────────────────────────────────────────────────────────

async function sendEmail(html, date) {
  const t = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await t.sendMail({
    from: '"Bitcoin Agent ₿" <' + FROM_EMAIL + '>',
    to: RECIPIENT_EMAIL,
    subject: "₿ Bitcoin Cycle Report — " + date,
    html: html,
  });
  console.log("Email sent to " + RECIPIENT_EMAIL);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  console.log("\nBitcoin Agent starting — " + date);

  try {
    console.log("Fetching 5 years of BTC price history...");
    const prices = await fetchPriceHistory("5years");
    console.log("Got " + prices.length + " daily data points");

    console.log("Computing indicators...");
    const indicators = computeIndicators(prices);
    console.log("Current price: $" + Math.round(indicators.currentPrice).toLocaleString());
    console.log("Mayer Multiple: " + indicators.mayerMultiple.toFixed(2) + "x");
    console.log("200 WMA: $" + Math.round(indicators.ma200w).toLocaleString());
    console.log("1458 SMA: $" + (indicators.sma1458 ? Math.round(indicators.sma1458).toLocaleString() : "N/A"));
    console.log("Pi Cycle Top: " + (indicators.piCycleTop ? "TRIGGERED ⚠️" : "Not triggered"));

    console.log("Fetching Fear & Greed Index...");
    const fg = await fetchFearGreed();
    if (fg) console.log("Fear & Greed: " + fg.value + " (" + fg.classification + ")");

    console.log("Analyzing with Claude...");
    const analysis = await analyzeBTC(indicators, fg);

    const html = buildEmail(indicators, fg, analysis, date);
    await sendEmail(html, date);
    console.log("Done!");
  } catch(err) {
    console.error("Error:", err.message);
    console.error(err.stack);
  }
}

// Run daily at 8am ET (5am PT)
cron.schedule("0 5 * * *", function() { run(); }, { timezone: "America/Los_Angeles" });
console.log("Bitcoin Agent scheduled — runs daily at 8am ET");
console.log("To run now: node btc-agent.js --now\n");
if (process.argv.indexOf("--now") !== -1) { run(); }
