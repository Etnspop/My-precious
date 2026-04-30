const $ = (sel) => document.querySelector(sel);

const fmt = (n, opts = {}) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, {
    style: opts.currency ? "currency" : "decimal",
    currency: opts.currency || undefined,
    minimumFractionDigits: opts.digits ?? 2,
    maximumFractionDigits: opts.digits ?? 2,
  });
};

const fmtUsd = (n) => fmt(n, { currency: "USD" });

const TYPE_COLORS = { stock: "#79c0ff", etf: "#d2a8ff", crypto: "#ffa657", cash: "#56d364" };

async function fetchHoldings() {
  const res = await fetch("/api/holdings");
  if (res.status === 401) { window.location.href = "/login"; throw new Error("Session expired"); }
  if (!res.ok) throw new Error("Failed to load");
  return res.json();
}

function renderRow(h) {
  const gainClass = h.gain >= 0 ? "pos" : "neg";
  const sign = h.gain >= 0 ? "+" : "";
  return `
    <tr data-id="${h.id}">
      <td><strong>${h.symbol}</strong>${h.note ? `<div style="color:var(--muted);font-size:0.78rem">${escapeHtml(h.note)}</div>` : ""}</td>
      <td><span class="tag ${h.asset_type}">${h.asset_type}</span></td>
      <td class="num">${fmt(h.quantity, { digits: 6 }).replace(/\.?0+$/, "")}</td>
      <td class="num">${h.cost_basis ? fmtUsd(h.cost_basis) : "—"}</td>
      <td class="num">${h.price !== null ? fmtUsd(h.price) : '<span style="color:var(--yellow)">n/a</span>'}</td>
      <td class="num"><strong>${fmtUsd(h.market_value)}</strong></td>
      <td class="num gain ${gainClass}">${sign}${fmtUsd(h.gain)}<div style="font-size:0.78rem">${sign}${fmt(h.gain_pct)}%</div></td>
      <td class="num">
        <button class="btn icon" data-action="edit">✎</button>
        <button class="btn icon danger" data-action="delete">✕</button>
      </td>
    </tr>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
          <span class="bar-label">${t}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${TYPE_COLORS[t] || "var(--accent)"}"></div></div>
          <span class="bar-value">${pct.toFixed(1)}%</span>
        </div>`;
    })
    .join("");
}

async function refresh() {
  const body = $("#holdings-body");
  body.innerHTML = '<tr><td colspan="8" class="empty">Loading prices…</td></tr>';
  try {
    const data = await fetchHoldings();
    if (!data.holdings.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No holdings yet — click "Add holding" to start.</td></tr>';
    } else {
      body.innerHTML = data.holdings.map(renderRow).join("");
    }
    $("#net-worth").textContent = fmtUsd(data.totals.market_value);
    $("#invested").textContent = fmtUsd(data.totals.invested);
    const gain = data.totals.gain;
    const gainEl = $("#total-gain");
    gainEl.textContent = `${gain >= 0 ? "+" : ""}${fmtUsd(gain)}`;
    gainEl.style.color = gain >= 0 ? "var(--green)" : "var(--red)";
    const sub = $("#net-gain");
    sub.textContent = data.totals.invested
      ? `${gain >= 0 ? "+" : ""}${fmt(data.totals.gain_pct)}% all-time`
      : "";
    sub.style.color = gain >= 0 ? "var(--green)" : "var(--red)";
    renderBreakdown(data.breakdown, data.totals.market_value);
    window.__holdings = data.holdings;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="empty">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

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

async function submitForm(e) {
  e.preventDefault();
  const id = $("#f-id").value;
  const payload = {
    symbol: $("#f-symbol").value.trim(),
    asset_type: $("#f-type").value,
    quantity: parseFloat($("#f-qty").value),
    cost_basis: parseFloat($("#f-cost").value || "0"),
    currency: $("#f-currency").value.trim() || "USD",
    note: $("#f-note").value.trim() || null,
  };
  const url = id ? `/api/holdings/${id}` : "/api/holdings";
  const method = id ? "PUT" : "POST";
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    $("#form-error").textContent = err.error || "Save failed";
    return;
  }
  closeModal();
  await refresh();
}

async function handleTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const tr = btn.closest("tr");
  const id = parseInt(tr.dataset.id, 10);
  const action = btn.dataset.action;
  if (action === "edit") {
    const holding = (window.__holdings || []).find((h) => h.id === id);
    if (holding) openModal(holding);
  } else if (action === "delete") {
    if (!confirm("Delete this holding?")) return;
    const res = await fetch(`/api/holdings/${id}`, { method: "DELETE" });
    if (res.ok) refresh();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#refresh-btn").addEventListener("click", refresh);
  $("#add-btn").addEventListener("click", () => openModal(null));
  $("#cancel-btn").addEventListener("click", closeModal);
  $("#holding-form").addEventListener("submit", submitForm);
  $("#holdings-body").addEventListener("click", handleTableClick);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  refresh();
  setInterval(refresh, 60000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }
});
