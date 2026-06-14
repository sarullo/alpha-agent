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

function fetchWithTimeout(url, options, ms) {
  ms = ms || 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(function() { ctrl.abort(); }, ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(function() { clearTimeout(timer); });
}

async function fetchPriceHistory(timespan) {
  const url = "https://api.blockchain.info/charts/market-price?timespan=" + timespan + "&format=json&sampled=false";
  const res = await fetchWithTimeout(url, {}, 60000); // 60s — large dataset
  const data = await res.json();
  if (!data.values) throw new Error("No price data returned");
  return data.values; // [{x: timestamp, y: price}]
}

// ─── Fetch current BTC price ──────────────────────────────────────────────────

async function fetchCurrentPrice() {
  const res = await fetchWithTimeout("https://api.blockchain.info/ticker", {}, 15000);
  const data = await res.json();
  return data.USD.last;
}

// ─── Fetch Fear & Greed Index ─────────────────────────────────────────────────

async function fetchFearGreed() {
  const res = await fetchWithTimeout("https://api.alternative.me/fng/?limit=30", {}, 15000);
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

  // Mayer Multiple: price / 200 DMA (spot and 7-day smoothed to avoid threshold flip-flopping)
  const mayerMultiple = sma200 ? now / sma200 : null;
  const price7dAvg = sma(closes, 7);
  const mayerMultiple7d = (sma200 && price7dAvg) ? price7dAvg / sma200 : null;

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
    mayerMultiple7d,
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
    "Mayer Multiple today (price/200DMA): " + fmt(ind.mayerMultiple, 2) + "x",
    "Mayer Multiple 7-day avg: " + fmt(ind.mayerMultiple7d, 2) + "x  ← use this for SIGNAL to avoid day-to-day noise",
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
    + "Respond in EXACTLY this format (no markdown, no bold, no headers, no asterisks — plain text only):\n\n"
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
    + "SIGNAL criteria — base SIGNAL on the 7-day avg Mayer Multiple (not today's spot) to avoid daily noise:\n"
    + "STRONG BUY: Mayer 7d avg < 0.8 AND Fear&Greed < 25 AND price near/below 200 WMA\n"
    + "BUY: Mayer 7d avg < 1.0 AND Fear&Greed < 45 AND cycle months 1-20 AND Pi Cycle not triggered\n"
    + "HOLD: Mayer 7d avg 0.8-1.2 with conflicting signals (late cycle, mixed F&G, etc.)\n"
    + "TAKE PROFITS: Mayer 7d avg > 1.5 AND cycle months 18+ AND Fear&Greed > 70\n"
    + "SELL: Pi Cycle Top triggered OR Mayer 7d avg > 2.4 OR Fear&Greed > 85\n"
    + "Note: Extreme Fear at late cycle (month 24+) is a conflicting signal — prefer HOLD over BUY unless price is at or below 200 WMA.\n"
    + "The signal should be STABLE week-to-week. Only change it when the underlying trend changes, not because of a 2-3% daily price move.\n"
    + "Never write N/A. Be specific about what the combination of indicators tells you.";

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "You are a Bitcoin cycle analyst with deep expertise in on-chain metrics, halving cycles, and technical indicators specific to Bitcoin. You understand the Mayer Multiple, Pi Cycle Top, 200 Week MA, and 1458 SMA indicators deeply. Give clear, specific, actionable analysis based on where we are in the 4-year cycle.",
      messages: [{ role: "user", content: prompt }],
    })
  }, 60000);

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = (data.content.find(function(b) { return b.type === "text"; }) || {}).text || "";
  console.log("\n── Claude raw response ──\n" + text + "\n────────────────────────\n");
  return text;
}

// ─── Parse fields ─────────────────────────────────────────────────────────────

function field(text, name) {
  // Handle markdown formatting: **Name**, ## Name, leading/trailing asterisks or hashes
  const m = text.match(new RegExp("^[*#\\s]*" + name + "[*#\\s]*:\\s*(.+)$", "im"));
  return m ? m[1].trim().replace(/\*\*/g, "").replace(/^#+\s*/, "") : "—";
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

function gauge(value, min, max, zones) {
  // zones: [{to: N, color: '#hex'}] in ascending order
  var pct = Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  var zoneHtml = '';
  var prev = 0;
  zones.forEach(function(z) {
    var w = Math.max(0, Math.min(100, (z.to - min) / (max - min) * 100)) - prev;
    zoneHtml += '<td style="width:' + w + '%;background:' + z.color + ';height:10px"></td>';
    prev += w;
  });
  var markerLeft = Math.round(pct);
  return '<table style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden"><tr>' + zoneHtml + '</tr></table>'
    + '<div style="position:relative;height:0"><div style="position:absolute;left:' + markerLeft + '%;transform:translateX(-50%);margin-top:-12px;width:3px;height:14px;background:#111;border-radius:2px"></div></div>';
}

function dot(color) {
  return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + color + ';margin-right:6px;vertical-align:middle"></span>';
}

function mayerColor(m) {
  if (m < 0.8)  return '#16a34a';
  if (m < 1.0)  return '#4ade80';
  if (m < 1.5)  return '#d97706';
  if (m < 2.4)  return '#ea580c';
  return '#dc2626';
}

function fgColor(v) {
  if (v < 20)  return '#16a34a';
  if (v < 40)  return '#4ade80';
  if (v < 60)  return '#d97706';
  if (v < 80)  return '#ea580c';
  return '#dc2626';
}

function returnColor(r) {
  if (r > 10)  return '#16a34a';
  if (r > 0)   return '#4ade80';
  if (r > -20) return '#d97706';
  return '#dc2626';
}

function buildEmail(ind, fg, analysis, date) {
  const fmt = function(n, d) { return (n !== null && n !== undefined) ? parseFloat(n).toFixed(d || 2) : "N/A"; };
  const fmtPrice = function(n) { return n ? "$" + Math.round(n).toLocaleString() : "N/A"; };
  const sig = signal(analysis);
  const col = signalColor(sig);

  const mm  = ind.mayerMultiple   || 0;
  const mm7 = ind.mayerMultiple7d || 0;
  const fgv = fg ? fg.value : 50;
  const r30 = ind.return30d  || 0;
  const r1y = ind.return365d || 0;

  // ── Mayer Multiple gauge (0 → 3) ──
  const mayerGauge = gauge(mm, 0, 3, [
    { to: 0.8, color: '#16a34a' },
    { to: 1.0, color: '#4ade80' },
    { to: 1.5, color: '#d97706' },
    { to: 2.4, color: '#ea580c' },
    { to: 3.0, color: '#dc2626' },
  ]);

  // ── Fear & Greed gauge (0 → 100) ──
  const fgGauge = gauge(fgv, 0, 100, [
    { to: 20,  color: '#16a34a' },
    { to: 40,  color: '#4ade80' },
    { to: 60,  color: '#d97706' },
    { to: 80,  color: '#ea580c' },
    { to: 100, color: '#dc2626' },
  ]);

  // ── Halving cycle gauge (0 → 100%) ──
  const cycPct = (ind.cycleProgress || 0) * 100;
  const cycleGauge = gauge(cycPct, 0, 100, [
    { to: 15,  color: '#16a34a' },
    { to: 45,  color: '#4ade80' },
    { to: 65,  color: '#d97706' },
    { to: 80,  color: '#ea580c' },
    { to: 100, color: '#dc2626' },
  ]);

  // ── Price vs 200 WMA status ──
  const above200w = ind.currentPrice > ind.ma200w;
  const wmaColor  = above200w ? '#d97706' : '#16a34a';
  const wmaLabel  = above200w ? 'Above 200 WMA' : 'Below 200 WMA — generational buy zone';

  // ── Pi Cycle status ──
  const piColor = ind.piCycleTop ? '#dc2626' : '#16a34a';
  const piLabel = ind.piCycleTop ? '⚠ TRIGGERED — top signal' : '✓ Not triggered — safe';

  // ── Indicator analysis rows with colored left border ──
  function indicatorColor(key) {
    var val = field(analysis, key).toLowerCase();
    if (/buy|accumulate|value|support|safe|not triggered/.test(val)) return '#16a34a';
    if (/neutral|hold|watch|mixed|cautious/.test(val)) return '#d97706';
    if (/sell|danger|peak|profit|overvalued|triggered/.test(val)) return '#dc2626';
    return '#94a3b8';
  }

  const rows = [
    ["Cycle Position", "Cycle"],
    ["Mayer Multiple", "MayerMultiple"],
    ["200 Week MA",    "MA200Week"],
    ["Pi Cycle Top",   "PiCycle"],
    ["1458 SMA",       "SMA1458"],
    ["Fear & Greed",   "FearGreed"],
    ["Support Level",  "SupportLevel"],
    ["Timeline",       "Timeline"],
  ].map(function(row) {
    var c = indicatorColor(row[1]);
    return '<tr>'
      + '<td style="padding:0;width:4px;background:' + c + '">&nbsp;</td>'
      + '<td style="padding:10px 12px;font-size:12px;color:#374151;white-space:nowrap;vertical-align:top;width:136px;font-weight:600;background:#f9fafb">' + row[0] + '</td>'
      + '<td style="padding:10px 12px;font-size:12px;color:#111827;line-height:1.6;border-bottom:1px solid #e5e7eb">' + field(analysis, row[1]) + '</td>'
      + '</tr>';
  }).join("");

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">'
    + '<div style="max-width:640px;margin:0 auto;padding:22px 14px">'

    // Header
    + '<div style="background:linear-gradient(135deg,#1c1917,#292524);border-radius:14px;padding:28px;margin-bottom:16px;text-align:center">'
    + '<div style="font-size:10px;letter-spacing:4px;color:#d97706;text-transform:uppercase;margin-bottom:6px">Bitcoin Cycle Intelligence</div>'
    + '<div style="font-size:32px;font-weight:900;color:#f7931a;letter-spacing:-1px">&#8383; BITCOIN AGENT</div>'
    + '<div style="margin-top:6px;font-size:12px;color:#a8a29e">' + date + '</div>'
    + '<div style="margin-top:16px;display:inline-block;background:' + col + ';color:#ffffff;padding:8px 24px;border-radius:30px;font-size:15px;font-weight:900;letter-spacing:2px">' + sig + '</div>'
    + '<div style="margin-top:8px;font-size:11px;color:#78716c">Confidence: ' + field(analysis, "Confidence") + ' &nbsp;·&nbsp; Support: ' + field(analysis, "SupportLevel") + ' &nbsp;·&nbsp; Target: ' + field(analysis, "BullTarget") + '</div>'
    + '</div>'

    // Summary
    + '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:16px;border-left:4px solid ' + col + '">'
    + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;margin-bottom:8px;font-weight:600">Analysis</div>'
    + '<div style="font-size:13px;color:#374151;line-height:1.7">' + field(analysis, "Summary") + '</div>'
    + '</div>'

    // ── Visual Gauges ──
    + '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:16px">'
    + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;margin-bottom:16px;font-weight:600">Cycle Gauges</div>'

    // Mayer Multiple
    + '<div style="margin-bottom:16px">'
    + '<table style="width:100%;border-collapse:collapse"><tr>'
    + '<td style="font-size:12px;font-weight:600;color:#374151">Mayer Multiple</td>'
    + '<td style="text-align:right;font-size:14px;font-weight:800;color:' + mayerColor(mm) + '">' + dot(mayerColor(mm)) + fmt(mm) + 'x <span style="font-size:11px;color:#94a3b8;font-weight:400">(7d: ' + fmt(mm7) + 'x)</span></td>'
    + '</tr></table>'
    + '<div style="margin-top:6px">' + mayerGauge + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin-top:4px"><tr>'
    + '<td style="font-size:10px;color:#16a34a">Deep Value</td><td style="font-size:10px;color:#d97706;text-align:center">Fair</td><td style="font-size:10px;color:#dc2626;text-align:right">Overheated</td>'
    + '</tr></table>'
    + '</div>'

    // Fear & Greed
    + '<div style="margin-bottom:16px">'
    + '<table style="width:100%;border-collapse:collapse"><tr>'
    + '<td style="font-size:12px;font-weight:600;color:#374151">Fear &amp; Greed Index</td>'
    + '<td style="text-align:right;font-size:14px;font-weight:800;color:' + fgColor(fgv) + '">' + dot(fgColor(fgv)) + (fg ? fg.value + '/100 — ' + fg.classification : 'N/A') + '</td>'
    + '</tr></table>'
    + '<div style="margin-top:6px">' + fgGauge + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin-top:4px"><tr>'
    + '<td style="font-size:10px;color:#16a34a">Extreme Fear</td><td style="font-size:10px;color:#d97706;text-align:center">Neutral</td><td style="font-size:10px;color:#dc2626;text-align:right">Extreme Greed</td>'
    + '</tr></table>'
    + '</div>'

    // Halving cycle
    + '<div style="margin-bottom:4px">'
    + '<table style="width:100%;border-collapse:collapse"><tr>'
    + '<td style="font-size:12px;font-weight:600;color:#374151">Halving Cycle Progress</td>'
    + '<td style="text-align:right;font-size:14px;font-weight:800;color:#374151">' + fmt(cycPct, 0) + '% <span style="font-size:11px;color:#94a3b8;font-weight:400">(Month ' + Math.floor(ind.daysSinceHalving / 30) + ')</span></td>'
    + '</tr></table>'
    + '<div style="margin-top:6px">' + cycleGauge + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin-top:4px"><tr>'
    + '<td style="font-size:10px;color:#16a34a">Accumulate</td><td style="font-size:10px;color:#4ade80;text-align:center">Bull Run</td><td style="font-size:10px;color:#d97706;text-align:center">Peak Zone</td><td style="font-size:10px;color:#dc2626;text-align:right">Bear</td>'
    + '</tr></table>'
    + '</div>'
    + '</div>'

    // ── Key Metrics (colored dots) ──
    + '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:16px">'
    + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;margin-bottom:12px;font-weight:600">Key Metrics</div>'
    + '<table style="width:100%;border-collapse:collapse">'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280;width:50%">Price</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + fmtPrice(ind.currentPrice) + '</td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">200 WMA</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + dot(wmaColor) + fmtPrice(ind.ma200w) + ' <span style="font-size:11px;color:' + wmaColor + ';font-weight:500">' + wmaLabel + '</span></td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">200 DMA</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + fmtPrice(ind.sma200) + '</td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">1458 SMA</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + fmtPrice(ind.sma1458) + ' <span style="font-size:11px;color:#6b7280;font-weight:400">(' + fmt(ind.priceVs1458) + 'x)</span></td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">Pi Cycle Top</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + dot(piColor) + '<span style="color:' + piColor + '">' + piLabel + '</span></td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">52W High</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + fmtPrice(ind.high52w) + '</td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">52W Low</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right">' + fmtPrice(ind.low52w) + '</td></tr>'
    + '<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:7px 0;font-size:12px;color:#6b7280">30d Return</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right;color:' + returnColor(r30) + '">' + dot(returnColor(r30)) + (r30 >= 0 ? '+' : '') + fmt(r30, 1) + '%</td></tr>'
    + '<tr><td style="padding:7px 0;font-size:12px;color:#6b7280">1Y Return</td><td style="padding:7px 0;font-size:13px;font-weight:700;text-align:right;color:' + returnColor(r1y) + '">' + dot(returnColor(r1y)) + (r1y >= 0 ? '+' : '') + fmt(r1y, 1) + '%</td></tr>'
    + '</table>'
    + '</div>'

    // Indicator analysis table
    + '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:16px">'
    + '<div style="padding:12px 20px;border-bottom:1px solid #e5e7eb;background:#f9fafb">'
    + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f7931a;font-weight:600">Indicator Breakdown</div>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse">' + rows + '</table>'
    + '</div>'

    // Footer
    + '<div style="text-align:center;padding:12px;font-size:10px;color:#6b7280;line-height:1.7">'
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
