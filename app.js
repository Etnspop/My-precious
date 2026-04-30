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

async function fetchCryptoPrice(symbol) {
  let pair = symbol.toUpperCase();
  if (!/(USDT|USD|BUSD|USDC)$/.test(pair)) pair += "USDT";
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`);
    if (r.ok) {
      const data = await r.json();
      const p = parseFloat(data.price);
      if (!isNaN(p)) return p;
    }
  } catch { /* fall through */ }
  // CoinGecko fallback (also helps for users in regions where Binance is blocked).
  try {
    const coin = symbol.toLowerCase().replace(/(usdt|usdc|busd|usd)$/, "");
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd`);
    if (r.ok) {
      const data = await r.json();
      const p = data?.[coin]?.usd;
      if (typeof p === "number") return p;
    }
  } catch {}
  return null;
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
  const r = await fetch(url);
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
  const r = await fetch(url);
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
    const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if (r.ok) {
      const data = await r.json();
      const rate = data?.rates?.[to];
      if (typeof rate === "number" && rate > 0) return rate;
    }
  } catch {}
  // Fallback: fawazahmed currency-api on jsDelivr (covers virtually every code)
  try {
    const r = await fetch(
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

function closeModal() { $("#modal").classList.add("hidden"); }

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

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeMenu(); } });

  refresh();
  setInterval(refresh, 60_000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
