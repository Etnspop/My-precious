const $ = (sel) => document.querySelector(sel);
const STORE_KEY = "myprecious.holdings.v1";
const SETTINGS_KEY = "myprecious.settings.v1";
const PRICE_TTL_MS = 60_000;
const FX_TTL_MS = 60 * 60_000;

const SUPPORTED_CURRENCIES = [
  ["USD", "US Dollar"], ["EUR", "Euro"], ["GBP", "British Pound"],
  ["JPY", "Japanese Yen"], ["CHF", "Swiss Franc"], ["CAD", "Canadian Dollar"],
  ["AUD", "Australian Dollar"], ["NZD", "New Zealand Dollar"],
  ["CNY", "Chinese Yuan"], ["HKD", "Hong Kong Dollar"], ["TWD", "Taiwan Dollar"],
  ["SGD", "Singapore Dollar"], ["KRW", "South Korean Won"],
  ["INR", "Indian Rupee"], ["IDR", "Indonesian Rupiah"], ["MYR", "Malaysian Ringgit"],
  ["PHP", "Philippine Peso"], ["THB", "Thai Baht"], ["VND", "Vietnamese Dong"],
  ["AED", "UAE Dirham"], ["SAR", "Saudi Riyal"], ["ILS", "Israeli Shekel"],
  ["TRY", "Turkish Lira"], ["RUB", "Russian Ruble"], ["ZAR", "South African Rand"],
  ["MXN", "Mexican Peso"], ["BRL", "Brazilian Real"], ["ARS", "Argentine Peso"],
  ["CLP", "Chilean Peso"], ["COP", "Colombian Peso"],
  ["NOK", "Norwegian Krone"], ["SEK", "Swedish Krona"], ["DKK", "Danish Krone"],
  ["PLN", "Polish Zloty"], ["CZK", "Czech Koruna"], ["HUF", "Hungarian Forint"],
];

let activeCurrency = "USD";
let activeRate = 1; // multiply USD value by this to get value in activeCurrency

const fmt = (n, opts = {}) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, {
    style: opts.currency ? "currency" : "decimal",
    currency: opts.currency || undefined,
    minimumFractionDigits: opts.digits ?? 2,
    maximumFractionDigits: opts.digits ?? 2,
  });
};

const fmtMoney = (usdValue) => {
  if (usdValue === null || usdValue === undefined || Number.isNaN(usdValue)) return "—";
  try {
    return (usdValue * activeRate).toLocaleString(undefined, {
      style: "currency",
      currency: activeCurrency,
    });
  } catch {
    return fmt(usdValue * activeRate, { digits: 2 }) + " " + activeCurrency;
  }
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TYPE_COLORS = { stock: "#79c0ff", etf: "#d2a8ff", crypto: "#ffa657", cash: "#56d364" };

// Bounded fetch — if a remote API hangs, abort it after timeoutMs so the
// caller's fallback chain (and the surrounding Promise.all) can keep moving.
// Without this, browsers will sit on a stalled connection for a long time
// and the holdings list stays stuck on "Loading prices…".
function tfetch(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// --- storage ----------------------------------------------------------------

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function getDisplayCurrency() { return loadSettings().displayCurrency || "USD"; }
function setDisplayCurrency(code) {
  const s = loadSettings();
  s.displayCurrency = code;
  saveSettings(s);
}

function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHoldings(holdings) {
  localStorage.setItem(STORE_KEY, JSON.stringify(holdings));
}

function newId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- price fetching ---------------------------------------------------------

const priceCache = new Map(); // key: `${type}:${symbol}` -> {at, price}

// Strip Yahoo-style "-USD" / "/USD" suffix from a crypto symbol so we can
// reliably build the right Binance pair and the right CoinGecko search.
// Examples: "BTC-USD" -> "BTC", "ETH/USDT" -> "ETH", "DOGE" -> "DOGE".
function normalizeCryptoSymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/[-/](USDT|USDC|BUSD|USD)$/, "");
}

// CoinGecko expects coin IDs ("bitcoin"), not symbols ("BTC"). Resolve the
// symbol to an ID via /search and cache the mapping for the session. The
// previous version queried `?ids=btc` and never returned a price, so when
// Binance was blocked (e.g., US IPs) crypto values went to 0.
const cgIdCache = new Map();

async function resolveCoinGeckoId(symbol) {
  if (!symbol) return null;
  const key = normalizeCryptoSymbol(symbol);
  if (!key) return null;
  if (cgIdCache.has(key)) return cgIdCache.get(key);
  try {
    const r = await tfetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(key)}`);
    if (r.ok) {
      const data = await r.json();
      const list = data.coins || [];
      // Prefer an exact symbol match with the lowest market-cap rank.
      const exact = list
        .filter((c) => (c.symbol || "").toUpperCase() === key)
        .sort((a, b) => (a.market_cap_rank || 9e9) - (b.market_cap_rank || 9e9))[0];
      const id = exact?.id || list[0]?.id || null;
      cgIdCache.set(key, id);
      return id;
    }
  } catch {}
  cgIdCache.set(key, null);
  return null;
}

async function fetchCryptoPrice(symbol) {
  const base = normalizeCryptoSymbol(symbol);
  let pair = base;
  if (!/(USDT|USD|BUSD|USDC)$/.test(pair)) pair += "USDT";
  try {
    const r = await tfetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`);
    if (r.ok) {
      const data = await r.json();
      const p = parseFloat(data.price);
      if (!isNaN(p)) return p;
    }
  } catch { /* fall through */ }
  // CoinGecko fallback — works in regions where Binance is blocked.
  const id = await resolveCoinGeckoId(symbol);
  if (id) {
    try {
      const r = await tfetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);
      if (r.ok) {
        const data = await r.json();
        const p = data?.[id]?.usd;
        if (typeof p === "number") return p;
      }
    } catch {}
  }
  return null;
}

async function fetchCoinGeckoHistory(symbol, days) {
  const id = await resolveCoinGeckoId(symbol);
  if (!id) return [];
  try {
    const r = await tfetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`
    );
    if (r.ok) {
      const data = await r.json();
      return (data.prices || [])
        .map(([t, v]) => ({ t, v }))
        .filter((p) => !isNaN(p.v) && p.v > 0);
    }
  } catch {}
  return [];
}

// Public CORS proxies — used as fallbacks when source APIs reject browser
// requests (Yahoo, Stooq currently strip CORS for most origins). Tried in
// order; the first one that returns a usable price wins.
const CORS_PROXIES = [
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

async function fetchYahooPrice(symbol, viaProxy) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const url = viaProxy ? viaProxy(target) : target;
  const r = await tfetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const p = meta?.regularMarketPrice ?? meta?.previousClose;
  return typeof p === "number" ? p : null;
}

async function fetchStooqPrice(symbol, viaProxy) {
  const ticker = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const target = `https://stooq.com/q/l/?s=${ticker}&f=sd2t2c&h&e=csv`;
  const url = viaProxy ? viaProxy(target) : target;
  const r = await tfetch(url);
  if (!r.ok) return null;
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(",");
  const close = parseFloat(cols[cols.length - 1]);
  return !isNaN(close) && close > 0 ? close : null;
}

async function fetchStockPrice(symbol) {
  // 1) Direct Yahoo (works in some browsers/regions/times)
  try { const p = await fetchYahooPrice(symbol, null); if (p !== null) return p; } catch {}
  // 2) Direct Stooq
  try { const p = await fetchStooqPrice(symbol, null); if (p !== null) return p; } catch {}
  // 3) Through public CORS proxies (Yahoo first since it has fresher data)
  for (const proxy of CORS_PROXIES) {
    try { const p = await fetchYahooPrice(symbol, proxy); if (p !== null) return p; } catch {}
    try { const p = await fetchStooqPrice(symbol, proxy); if (p !== null) return p; } catch {}
  }
  return null;
}

async function getPrice(symbol, type) {
  if (type === "cash") return 1;
  const key = `${type}:${symbol.toUpperCase()}`;
  const cached = priceCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < PRICE_TTL_MS) return cached.price;
  const price = type === "crypto" ? await fetchCryptoPrice(symbol) : await fetchStockPrice(symbol);
  if (price !== null) priceCache.set(key, { at: now, price });
  return price;
}

// --- FX rates ---------------------------------------------------------------

const fxCache = new Map(); // "USD->EUR" -> {at, rate}

async function fetchFxRate(from, to) {
  if (from === to) return 1;
  // Frankfurter (ECB-backed, ~30 major currencies)
  try {
    const r = await tfetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (r.ok) {
      const data = await r.json();
      const rate = data?.rates?.[to];
      if (typeof rate === "number" && rate > 0) return rate;
    }
  } catch {}
  // Fallback: fawazahmed currency-api on jsDelivr (covers virtually every code)
  try {
    const r = await tfetch(
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from.toLowerCase()}.json`
    );
    if (r.ok) {
      const data = await r.json();
      const rate = data?.[from.toLowerCase()]?.[to.toLowerCase()];
      if (typeof rate === "number" && rate > 0) return rate;
    }
  } catch {}
  return null;
}

async function getFxRate(from, to) {
  if (from === to) return 1;
  const key = `${from}->${to}`;
  const cached = fxCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < FX_TTL_MS) return cached.rate;
  const rate = await fetchFxRate(from, to);
  if (rate !== null) fxCache.set(key, { at: now, rate });
  return rate;
}

async function ensureFx() {
  activeCurrency = getDisplayCurrency();
  if (activeCurrency === "USD") {
    activeRate = 1;
    return;
  }
  const rate = await getFxRate("USD", activeCurrency);
  activeRate = rate ?? 1; // fall back to 1 (renders the USD number under the chosen label)
}

// --- rendering --------------------------------------------------------------

function compute(holding, price) {
  const qty = Number(holding.quantity) || 0;
  const cost = Number(holding.cost_basis) || 0;
  const market_value = (price ?? 0) * qty;
  const invested = cost * qty;
  const gain = market_value - invested;
  const gain_pct = invested ? (gain / invested) * 100 : 0;
  return { ...holding, price, market_value, invested, gain, gain_pct };
}

function renderRow(h) {
  const gainClass = h.gain >= 0 ? "pos" : "neg";
  const sign = h.gain >= 0 ? "+" : "";
  const qtyDisplay = fmt(h.quantity, { digits: 6 }).replace(/\.?0+$/, "");
  return `
    <tr data-id="${escapeHtml(h.id)}">
      <td><strong>${escapeHtml(h.symbol)}</strong>${h.note ? `<div style="color:var(--muted);font-size:0.78rem">${escapeHtml(h.note)}</div>` : ""}</td>
      <td><span class="tag ${escapeHtml(h.asset_type)}">${escapeHtml(h.asset_type)}</span></td>
      <td class="num">${qtyDisplay}</td>
      <td class="num">${h.cost_basis ? fmtMoney(h.cost_basis) : "—"}</td>
      <td class="num">${h.price !== null && h.price !== undefined ? fmtMoney(h.price) : '<span style="color:var(--yellow)">n/a</span>'}</td>
      <td class="num"><strong>${fmtMoney(h.market_value)}</strong></td>
      <td class="num gain ${gainClass}">${sign}${fmtMoney(h.gain)}<div style="font-size:0.78rem">${sign}${fmt(h.gain_pct)}%</div></td>
      <td class="num">
        <button class="btn icon" data-action="edit">✎</button>
        <button class="btn icon danger" data-action="delete">✕</button>
      </td>
    </tr>`;
}

function renderBreakdown(breakdown, total) {
  const el = $("#breakdown");
  const types = Object.keys(breakdown);
  if (!types.length || total <= 0) {
    el.innerHTML = '<span style="color:var(--muted);font-size:0.85rem">No assets yet</span>';
    return;
  }
  el.innerHTML = types
    .sort((a, b) => breakdown[b] - breakdown[a])
    .map((t) => {
      const pct = (breakdown[t] / total) * 100;
      return `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(t)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${TYPE_COLORS[t] || "var(--accent)"}"></div></div>
          <span class="bar-value">${pct.toFixed(1)}%</span>
        </div>`;
    })
    .join("");
}

async function refresh() {
  await ensureFx();
  const body = $("#holdings-body");
  const holdings = loadHoldings();
  if (!holdings.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No holdings yet — tap "Add holding" to start.</td></tr>';
    $("#net-worth").textContent = fmtMoney(0);
    $("#invested").textContent = fmtMoney(0);
    $("#total-gain").textContent = fmtMoney(0);
    $("#net-gain").textContent = "";
    renderBreakdown({}, 0);
    window.__holdings = [];
    return;
  }
  body.innerHTML = '<tr><td colspan="8" class="empty">Loading prices…</td></tr>';

  const computed = await Promise.all(
    holdings.map(async (h) => compute(h, await getPrice(h.symbol, h.asset_type)))
  );

  body.innerHTML = computed
    .slice()
    .sort((a, b) => a.asset_type.localeCompare(b.asset_type) || a.symbol.localeCompare(b.symbol))
    .map(renderRow)
    .join("");

  const totals = computed.reduce(
    (acc, h) => {
      acc.market_value += h.market_value;
      acc.invested += h.invested;
      return acc;
    },
    { market_value: 0, invested: 0 }
  );
  totals.gain = totals.market_value - totals.invested;
  totals.gain_pct = totals.invested ? (totals.gain / totals.invested) * 100 : 0;

  const breakdown = computed.reduce((acc, h) => {
    acc[h.asset_type] = (acc[h.asset_type] || 0) + h.market_value;
    return acc;
  }, {});

  $("#net-worth").textContent = fmtMoney(totals.market_value);
  $("#invested").textContent = fmtMoney(totals.invested);
  const gainEl = $("#total-gain");
  gainEl.textContent = `${totals.gain >= 0 ? "+" : ""}${fmtMoney(totals.gain)}`;
  gainEl.style.color = totals.gain >= 0 ? "var(--green)" : "var(--red)";
  const sub = $("#net-gain");
  sub.textContent = totals.invested ? `${totals.gain >= 0 ? "+" : ""}${fmt(totals.gain_pct)}% all-time` : "";
  sub.style.color = totals.gain >= 0 ? "var(--green)" : "var(--red)";
  renderBreakdown(breakdown, totals.market_value);

  window.__holdings = computed;
  await renderChart(); // refresh chart whenever holdings/prices update
}

// --- historical data + chart ------------------------------------------------

const RANGE_DAYS = { "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "5y": 1825 };

function rangeCutoffMs(range) {
  if (range === "ytd") {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), 0, 1);
  }
  const days = RANGE_DAYS[range] || 365;
  return Date.now() - days * 24 * 3600 * 1000;
}

function rangeDays(range) {
  if (range === "ytd") {
    const start = rangeCutoffMs("ytd");
    return Math.max(1, Math.ceil((Date.now() - start) / (24 * 3600 * 1000)));
  }
  return RANGE_DAYS[range] || 365;
}
const historyCache = new Map(); // key: `${symbol}:${type}:${range}` -> {at, points}
const HISTORY_TTL_MS = 30 * 60_000;

let chartState = {
  range: "1y",
  benchmark: "^GSPC",
};

async function fetchYahooHistory(symbol, range) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const fetchers = [() => tfetch(target), ...CORS_PROXIES.map((p) => () => tfetch(p(target)))];
  for (const get of fetchers) {
    try {
      const r = await get();
      if (!r.ok) continue;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const points = [];
      for (let i = 0; i < ts.length; i++) {
        const v = closes[i];
        if (typeof v === "number" && !isNaN(v) && v > 0) points.push({ t: ts[i] * 1000, v });
      }
      if (points.length) return points;
    } catch {}
  }
  return [];
}

async function fetchBinanceHistory(symbol, range) {
  const base = normalizeCryptoSymbol(symbol);
  let pair = base;
  if (!/(USDT|USD|BUSD|USDC)$/.test(pair)) pair += "USDT";
  const limit = Math.min(1000, rangeDays(range));
  try {
    const r = await tfetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${limit}`);
    if (r.ok) {
      const data = await r.json();
      return data.map((k) => ({ t: k[0], v: parseFloat(k[4]) })).filter((p) => !isNaN(p.v) && p.v > 0);
    }
  } catch {}
  return [];
}

async function fetchHistory(symbol, type, range) {
  const key = `${type}:${symbol.toUpperCase()}:${range}`;
  const cached = historyCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < HISTORY_TTL_MS) return cached.points;
  let points = [];
  if (type === "crypto") {
    points = await fetchBinanceHistory(symbol, range);
    if (!points.length) points = await fetchYahooHistory(`${normalizeCryptoSymbol(symbol)}-USD`, range);
    if (!points.length) points = await fetchCoinGeckoHistory(symbol, rangeDays(range));
  } else {
    points = await fetchYahooHistory(symbol, range);
  }
  historyCache.set(key, { at: now, points });
  return points;
}

// Build a portfolio time series at daily granularity. For each day in the
// union of all holdings' history timestamps, compute sum(qty * forward-filled
// price). Cash is constant at 1 USD. All math is in USD.
async function computePortfolioSeries(holdings, range) {
  const cutoff = rangeCutoffMs(range);
  const histories = await Promise.all(
    holdings.map((h) => h.asset_type === "cash" ? Promise.resolve(null) : fetchHistory(h.symbol, h.asset_type, range))
  );

  // Build union of timestamps (rounded to UTC midnight to align stocks across exchanges).
  const dayMs = 24 * 3600 * 1000;
  const tsSet = new Set();
  histories.forEach((h) => h?.forEach((p) => {
    if (p.t < cutoff) return;
    tsSet.add(Math.floor(p.t / dayMs) * dayMs);
  }));
  if (!tsSet.size) return [];
  const sortedTs = Array.from(tsSet).sort((a, b) => a - b);

  // Forward-fill each holding to the unified day grid.
  const aligned = holdings.map((h, i) => {
    if (h.asset_type === "cash") return sortedTs.map(() => 1);
    const hist = histories[i];
    if (!hist || !hist.length) return null;
    const out = new Array(sortedTs.length).fill(null);
    let last = null;
    let idx = 0;
    for (let j = 0; j < sortedTs.length; j++) {
      while (idx < hist.length && hist[idx].t <= sortedTs[j] + dayMs) {
        last = hist[idx].v;
        idx++;
      }
      out[j] = last;
    }
    return out;
  });

  const series = [];
  for (let j = 0; j < sortedTs.length; j++) {
    let total = 0;
    let allMissing = true;
    for (let i = 0; i < holdings.length; i++) {
      const a = aligned[i];
      if (!a) continue;
      const price = a[j];
      if (price !== null) {
        total += holdings[i].quantity * price;
        allMissing = false;
      }
    }
    if (!allMissing) series.push({ t: sortedTs[j], v: total });
  }
  return series;
}

function escapeAttr(s) { return escapeHtml(s); }

function renderSvgChart(host, seriesList) {
  if (!seriesList.length || !seriesList[0].points.length) {
    host.innerHTML = '<div class="chart-empty">No history available.</div>';
    return;
  }
  const W = 800, H = 240;
  const padL = 56, padR = 14, padT = 10, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  const allPts = seriesList.flatMap((s) => s.points);
  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of allPts) {
    if (p.t < minT) minT = p.t;
    if (p.t > maxT) maxT = p.t;
    if (p.v < minV) minV = p.v;
    if (p.v > maxV) maxV = p.v;
  }
  if (!isFinite(minT) || maxT === minT) {
    host.innerHTML = '<div class="chart-empty">Not enough history yet.</div>';
    return;
  }
  const pad = (maxV - minV) * 0.05 || 1;
  minV -= pad; maxV += pad;

  const x = (t) => padL + ((t - minT) / (maxT - minT)) * innerW;
  const y = (v) => padT + (1 - (v - minV) / (maxV - minV)) * innerH;

  // Y-axis ticks (4 evenly spaced)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const v = minV + ((maxV - minV) * i) / 4;
    yTicks.push({ v, y: y(v) });
  }

  // X-axis ticks (start, mid, end)
  const xTicks = [
    { t: minT, x: x(minT) },
    { t: (minT + maxT) / 2, x: x((minT + maxT) / 2) },
    { t: maxT, x: x(maxT) },
  ];

  const fmtAxisDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  const fmtAxisY = (v) => fmtMoney(v).replace(/\.\d+$/, "");

  const grid = yTicks.map((t) =>
    `<line x1="${padL}" x2="${W - padR}" y1="${t.y}" y2="${t.y}"/>`
  ).join("");

  const yLabels = yTicks.map((t) =>
    `<text x="${padL - 6}" y="${t.y + 4}" text-anchor="end">${escapeAttr(fmtAxisY(t.v))}</text>`
  ).join("");

  const xLabels = xTicks.map((t) =>
    `<text x="${t.x}" y="${H - 6}" text-anchor="middle">${escapeAttr(fmtAxisDate(t.t))}</text>`
  ).join("");

  const lines = seriesList.map((s) => {
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    return `<path class="chart-line" d="${d}" stroke="${escapeAttr(s.color)}"/>`;
  }).join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <g class="chart-grid">${grid}</g>
      <g class="chart-axis">${yLabels}${xLabels}</g>
      ${lines}
    </svg>`;
}

function renderLegend(seriesList) {
  const el = $("#chart-legend");
  if (!seriesList.length) { el.innerHTML = ""; return; }
  el.innerHTML = seriesList.map((s) => {
    const first = s.points[0]?.v ?? 0;
    const last = s.points[s.points.length - 1]?.v ?? 0;
    const pct = first ? ((last - first) / first) * 100 : 0;
    const cls = pct >= 0 ? "pos" : "neg";
    const sign = pct >= 0 ? "+" : "";
    return `
      <span class="lg">
        <span class="swatch" style="background:${escapeAttr(s.color)}"></span>
        <span>${escapeAttr(s.label)}</span>
        <span class="lg-meta">${escapeAttr(fmtMoney(last))}</span>
        <span class="lg-pct ${cls}">${sign}${pct.toFixed(2)}%</span>
      </span>`;
  }).join("");
}

async function renderChart() {
  const host = $("#chart-host");
  if (!host) return;
  const holdings = loadHoldings();
  if (!holdings.length) {
    host.innerHTML = '<div class="chart-empty">Add holdings to see performance.</div>';
    $("#chart-legend").innerHTML = "";
    return;
  }
  host.innerHTML = '<div class="chart-empty chart-loading">Loading chart…</div>';

  const range = chartState.range;
  const benchSym = chartState.benchmark === "__custom__"
    ? ($("#bench-custom")?.value.trim() || "")
    : chartState.benchmark;

  const portfolio = await computePortfolioSeries(holdings, range);
  if (!portfolio.length) {
    host.innerHTML = '<div class="chart-empty">No price history available for these holdings.</div>';
    $("#chart-legend").innerHTML = "";
    return;
  }

  const series = [{
    label: "Portfolio",
    color: "#5cc8ff",
    points: portfolio,
  }];

  if (benchSym) {
    let benchPoints = await fetchYahooHistory(benchSym, range);
    if (!benchPoints.length && /^[A-Z]+$/.test(benchSym)) {
      // try crypto fallback for short tickers like BTC
      benchPoints = await fetchYahooHistory(`${benchSym}-USD`, range);
    }
    if (benchPoints.length) {
      // Trim to portfolio time range and rebase to portfolio's starting value.
      const pStart = portfolio[0].t;
      const trimmed = benchPoints.filter((p) => p.t >= pStart - 24 * 3600 * 1000);
      if (trimmed.length) {
        const baseline = trimmed[0].v;
        const scale = portfolio[0].v / baseline;
        series.push({
          label: benchLabel(benchSym),
          color: "#d29922",
          points: trimmed.map((p) => ({ t: p.t, v: p.v * scale })),
        });
      }
    }
  }

  // Convert all USD points to active currency for display.
  const display = series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ t: p.t, v: p.v * activeRate })),
  }));

  renderSvgChart(host, display);
  renderLegend(display);
}

function benchLabel(sym) {
  const map = {
    "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow Jones",
    "^RUT": "Russell 2000", "^N225": "Nikkei 225", "^HSI": "Hang Seng",
    "^FTSE": "FTSE 100", "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum",
    "GC=F": "Gold",
  };
  return map[sym] || sym;
}

// --- symbol autocomplete ----------------------------------------------------

// Map browser locale -> Yahoo Finance lang/region pair.
function detectYahooLocale() {
  const raw = (navigator.language || "en-US").toLowerCase();
  if (raw.startsWith("zh-tw") || raw === "zh-hant" || raw.startsWith("zh-hant")) return { lang: "zh-TW", region: "TW" };
  if (raw.startsWith("zh-hk")) return { lang: "zh-HK", region: "HK" };
  if (raw.startsWith("zh-cn") || raw.startsWith("zh-hans") || raw === "zh") return { lang: "zh-CN", region: "CN" };
  if (raw.startsWith("ja")) return { lang: "ja-JP", region: "JP" };
  if (raw.startsWith("ko")) return { lang: "ko-KR", region: "KR" };
  if (raw.startsWith("de")) return { lang: "de-DE", region: "DE" };
  if (raw.startsWith("fr")) return { lang: "fr-FR", region: "FR" };
  if (raw.startsWith("es")) return { lang: "es-ES", region: "ES" };
  if (raw.startsWith("pt-br")) return { lang: "pt-BR", region: "BR" };
  return { lang: "en-US", region: "US" };
}

const HAS_CJK = /[㐀-鿿぀-ヿ가-힯]/;
const HAS_HIRAKATA = /[぀-ヿ]/;
const HAS_HANGUL = /[가-힯]/;

async function fetchYahooSearchOnce(query, lang, region) {
  const target = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true&lang=${lang}&region=${region}`;
  const fetchers = [() => tfetch(target), ...CORS_PROXIES.map((p) => () => tfetch(p(target)))];
  for (const get of fetchers) {
    try {
      const r = await get();
      if (!r.ok) continue;
      const data = await r.json();
      const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
      const out = [];
      for (const q of quotes) {
        const t = (q.quoteType || "").toUpperCase();
        let assetType = null;
        if (t === "ETF") assetType = "etf";
        else if (t === "EQUITY" || t === "MUTUALFUND" || t === "INDEX") assetType = "stock";
        else if (t === "CRYPTOCURRENCY") assetType = "crypto";
        if (!assetType || !q.symbol) continue;
        out.push({
          symbol: q.symbol,
          name: q.shortname || q.longname || q.symbol,
          asset_type: assetType,
          exchange: q.exchDisp || q.exchange || "",
        });
      }
      if (out.length) return out;
    } catch {}
  }
  return [];
}

async function searchYahooSymbols(query) {
  const browserLoc = detectYahooLocale();
  // For CJK queries, walk through several regional locales until one returns
  // results — Yahoo's search behavior varies by region and a single locale
  // (e.g. zh-HK) sometimes fails to surface stocks listed in another market
  // (e.g. 台積電 on TWSE). Try the most relevant region per script first.
  if (HAS_CJK.test(query)) {
    const tries = HAS_HIRAKATA.test(query)
      ? [["ja-JP", "JP"], ["zh-TW", "TW"], ["zh-HK", "HK"], ["en-US", "US"]]
      : HAS_HANGUL.test(query)
      ? [["ko-KR", "KR"], ["zh-TW", "TW"], ["en-US", "US"]]
      : [["zh-TW", "TW"], ["zh-HK", "HK"], ["zh-CN", "CN"], ["ja-JP", "JP"], ["en-US", "US"]];
    for (const [lang, region] of tries) {
      const out = await fetchYahooSearchOnce(query, lang, region);
      if (out.length) return out;
    }
    return [];
  }
  return fetchYahooSearchOnce(query, browserLoc.lang, browserLoc.region);
}

async function searchCryptoSymbols(query) {
  try {
    const r = await tfetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.coins || []).slice(0, 10).map((c) => ({
      symbol: (c.symbol || "").toUpperCase(),
      name: c.name,
      asset_type: "crypto",
      exchange: "Crypto",
    }));
  } catch {
    return [];
  }
}

async function searchSymbols(query, type) {
  if (!query) return [];
  if (type === "crypto") return searchCryptoSymbols(query);
  if (type === "cash") return [];
  return searchYahooSymbols(query);
}

let _suggestTimer = null;
let _suggestSeq = 0;

function setupAutocomplete() {
  const input = $("#f-symbol");
  const list = $("#symbol-suggestions");
  const typeSelect = $("#f-type");
  if (!input || !list) return;

  const hide = () => { list.classList.add("hidden"); list.innerHTML = ""; };

  const render = (items) => {
    if (!items.length) {
      list.innerHTML = '<li class="empty">No matches</li>';
      list.classList.remove("hidden");
      return;
    }
    list.innerHTML = items
      .map((it) => `
        <li role="option"
            data-symbol="${escapeHtml(it.symbol)}"
            data-type="${escapeHtml(it.asset_type)}">
          <span class="sym">${escapeHtml(it.symbol)}</span>
          <span class="meta">${escapeHtml(it.name)}${it.exchange ? `<span class="badge">${escapeHtml(it.exchange)}</span>` : ""}</span>
        </li>
      `)
      .join("");
    list.classList.remove("hidden");
  };

  const runSearch = async () => {
    const query = input.value.trim();
    if (query.length < 1) { hide(); return; }
    const seq = ++_suggestSeq;
    const results = await searchSymbols(query, typeSelect.value);
    if (seq !== _suggestSeq) return; // a newer query has fired; ignore stale results
    render(results);
  };

  input.addEventListener("input", () => {
    clearTimeout(_suggestTimer);
    if (!input.value.trim()) { hide(); return; }
    _suggestTimer = setTimeout(runSearch, 220);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 1) runSearch();
  });

  // Use mousedown / touchstart so we beat the input blur handler.
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-symbol]");
    if (!li) return;
    e.preventDefault();
    input.value = li.dataset.symbol;
    if (li.dataset.type) typeSelect.value = li.dataset.type;
    hide();
    input.focus();
  });

  input.addEventListener("blur", () => { setTimeout(hide, 180); });

  typeSelect.addEventListener("change", () => {
    if (input.value.trim().length >= 1) runSearch();
  });
}

// --- form / CRUD ------------------------------------------------------------

function openModal(holding) {
  $("#modal").classList.remove("hidden");
  $("#form-error").textContent = "";
  $("#modal-title").textContent = holding ? "Edit holding" : "Add holding";
  $("#f-id").value = holding?.id || "";
  $("#f-symbol").value = holding?.symbol || "";
  $("#f-type").value = holding?.asset_type || "stock";
  $("#f-qty").value = holding?.quantity ?? "";
  $("#f-cost").value = holding?.cost_basis ?? 0;
  $("#f-currency").value = holding?.currency || "USD";
  $("#f-note").value = holding?.note || "";
  setTimeout(() => $("#f-symbol").focus(), 50);
}

function closeModal() {
  $("#modal").classList.add("hidden");
  const sugg = $("#symbol-suggestions");
  if (sugg) { sugg.classList.add("hidden"); sugg.innerHTML = ""; }
}

function validate(payload) {
  if (!payload.symbol) return "symbol is required";
  if (!["stock", "etf", "crypto", "cash"].includes(payload.asset_type)) return "invalid asset type";
  if (!(payload.quantity > 0)) return "quantity must be positive";
  if (payload.cost_basis < 0 || isNaN(payload.cost_basis)) return "cost must be a number";
  return null;
}

function submitForm(e) {
  e.preventDefault();
  const id = $("#f-id").value;
  const payload = {
    symbol: $("#f-symbol").value.trim().toUpperCase(),
    asset_type: $("#f-type").value,
    quantity: parseFloat($("#f-qty").value),
    cost_basis: parseFloat($("#f-cost").value || "0"),
    currency: ($("#f-currency").value.trim() || "USD").toUpperCase(),
    note: $("#f-note").value.trim() || null,
  };
  const err = validate(payload);
  if (err) { $("#form-error").textContent = err; return; }

  const holdings = loadHoldings();
  if (id) {
    // Editing — replace the specific holding without merging.
    const idx = holdings.findIndex((h) => h.id === id);
    if (idx >= 0) holdings[idx] = { ...holdings[idx], ...payload };
  } else {
    // Adding — if a holding with the same symbol+type already exists, merge
    // into it (sum quantities, weighted-average cost). Otherwise append.
    const existingIdx = holdings.findIndex(
      (h) => h.symbol === payload.symbol && h.asset_type === payload.asset_type
    );
    if (existingIdx >= 0) {
      const existing = holdings[existingIdx];
      const totalQty = (existing.quantity || 0) + payload.quantity;
      const oldInvested = (existing.quantity || 0) * (existing.cost_basis || 0);
      const newInvested = payload.quantity * (payload.cost_basis || 0);
      const weightedCost = totalQty > 0 ? (oldInvested + newInvested) / totalQty : 0;
      holdings[existingIdx] = {
        ...existing,
        quantity: totalQty,
        cost_basis: weightedCost,
        note: existing.note || payload.note,
      };
    } else {
      holdings.push({ id: newId(), ...payload });
    }
  }
  saveHoldings(holdings);
  closeModal();
  refresh();
}

function handleTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const tr = btn.closest("tr");
  const id = tr.dataset.id;
  const action = btn.dataset.action;
  if (action === "edit") {
    const h = (window.__holdings || []).find((x) => x.id === id) || loadHoldings().find((x) => x.id === id);
    if (h) openModal(h);
  } else if (action === "delete") {
    if (!confirm("Delete this holding?")) return;
    const holdings = loadHoldings().filter((h) => h.id !== id);
    saveHoldings(holdings);
    refresh();
  }
}

// --- export / import / clear -----------------------------------------------

function openMenu()  { $("#menu").classList.remove("hidden"); }
function closeMenu() { $("#menu").classList.add("hidden"); }

function exportPortfolio() {
  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    holdings: loadHoldings(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `my-precious-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importPortfolio(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = Array.isArray(parsed) ? parsed : parsed.holdings;
      if (!Array.isArray(incoming)) throw new Error("invalid format");
      const sanitized = incoming
        .filter((h) => h && h.symbol && h.asset_type && h.quantity)
        .map((h) => ({
          id: h.id || newId(),
          symbol: String(h.symbol).toUpperCase(),
          asset_type: String(h.asset_type).toLowerCase(),
          quantity: Number(h.quantity),
          cost_basis: Number(h.cost_basis) || 0,
          currency: (h.currency || "USD").toUpperCase(),
          note: h.note || null,
        }));
      const choice = confirm(
        `Import ${sanitized.length} holding(s)?\n\nOK = replace your current portfolio.\nCancel = keep current portfolio.`
      );
      if (!choice) return;
      saveHoldings(sanitized);
      closeMenu();
      refresh();
    } catch (e) {
      alert("Could not import file: " + e.message);
    }
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm("Delete ALL holdings? This cannot be undone.")) return;
  saveHoldings([]);
  closeMenu();
  refresh();
}

// --- bootstrap --------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  $("#refresh-btn").addEventListener("click", () => { priceCache.clear(); refresh(); });
  $("#add-btn").addEventListener("click", () => openModal(null));
  $("#cancel-btn").addEventListener("click", closeModal);
  $("#holding-form").addEventListener("submit", submitForm);
  $("#holdings-body").addEventListener("click", handleTableClick);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  $("#menu-btn").addEventListener("click", openMenu);
  $("#menu-close").addEventListener("click", closeMenu);
  $("#menu").addEventListener("click", (e) => { if (e.target.id === "menu") closeMenu(); });
  $("#export-btn").addEventListener("click", exportPortfolio);
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importPortfolio(e.target.files[0]); e.target.value = ""; });
  $("#clear-btn").addEventListener("click", clearAll);

  const sel = $("#currency-select");
  sel.innerHTML = SUPPORTED_CURRENCIES.map(([code, name]) =>
    `<option value="${code}">${code} — ${name}</option>`
  ).join("");
  sel.value = getDisplayCurrency();
  sel.addEventListener("change", async () => {
    setDisplayCurrency(sel.value);
    fxCache.clear();
    await refresh();
  });

  setupAutocomplete();

  // Chart controls
  document.querySelectorAll(".range-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      chartState.range = b.dataset.range;
      renderChart();
    });
  });
  const benchSel = $("#bench-select");
  const benchCustom = $("#bench-custom");
  benchSel.addEventListener("change", () => {
    chartState.benchmark = benchSel.value;
    if (benchSel.value === "__custom__") {
      benchCustom.classList.remove("hidden");
      benchCustom.focus();
    } else {
      benchCustom.classList.add("hidden");
      renderChart();
    }
  });
  let benchTimer = null;
  benchCustom.addEventListener("input", () => {
    clearTimeout(benchTimer);
    benchTimer = setTimeout(renderChart, 400);
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeMenu(); } });

  refresh();
  setInterval(refresh, 60_000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
