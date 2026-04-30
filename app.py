"""Portfolio tracker: stores holdings in SQLite and prices them via yfinance + Binance."""
from __future__ import annotations

import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from typing import Any

import requests
import yfinance as yf
from flask import Flask, g, jsonify, render_template, request

DB_PATH = os.environ.get("PORTFOLIO_DB", os.path.join(os.path.dirname(__file__), "portfolio.db"))
ASSET_TYPES = {"stock", "etf", "crypto", "cash"}
PRICE_TTL_SECONDS = 60

app = Flask(__name__)

_price_cache: dict[tuple[str, str], tuple[float, float]] = {}


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc: BaseException | None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    with closing(sqlite3.connect(DB_PATH)) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS holdings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                asset_type TEXT NOT NULL CHECK (asset_type IN ('stock','etf','crypto','cash')),
                quantity REAL NOT NULL,
                cost_basis REAL NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT 'USD',
                note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )
        conn.commit()


def fetch_stock_price(symbol: str) -> float | None:
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
        info = ticker.fast_info
        price = info.get("last_price") if hasattr(info, "get") else getattr(info, "last_price", None)
        return float(price) if price else None
    except Exception:
        return None


def fetch_crypto_price(symbol: str) -> float | None:
    pair = symbol.upper()
    if not pair.endswith(("USDT", "USD", "BUSD", "USDC")):
        pair = f"{pair}USDT"
    try:
        r = requests.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": pair},
            timeout=8,
        )
        if r.status_code == 200:
            return float(r.json()["price"])
    except Exception:
        pass
    # Fallback: CoinGecko simple price
    try:
        coin = symbol.lower().replace("usdt", "").replace("usd", "")
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin, "vs_currencies": "usd"},
            timeout=8,
        )
        if r.status_code == 200:
            data = r.json()
            if coin in data and "usd" in data[coin]:
                return float(data[coin]["usd"])
    except Exception:
        pass
    return None


def get_price(symbol: str, asset_type: str) -> float | None:
    if asset_type == "cash":
        return 1.0
    key = (symbol.upper(), asset_type)
    cached = _price_cache.get(key)
    now = time.time()
    if cached and now - cached[0] < PRICE_TTL_SECONDS:
        return cached[1]
    price = fetch_crypto_price(symbol) if asset_type == "crypto" else fetch_stock_price(symbol)
    if price is not None:
        _price_cache[key] = (now, price)
    return price


def serialize(row: sqlite3.Row, price: float | None) -> dict[str, Any]:
    qty = row["quantity"]
    cost = row["cost_basis"]
    market_value = (price or 0) * qty
    invested = cost * qty
    gain = market_value - invested
    gain_pct = (gain / invested * 100) if invested else 0.0
    return {
        "id": row["id"],
        "symbol": row["symbol"],
        "asset_type": row["asset_type"],
        "quantity": qty,
        "cost_basis": cost,
        "currency": row["currency"],
        "note": row["note"],
        "price": price,
        "market_value": market_value,
        "invested": invested,
        "gain": gain,
        "gain_pct": gain_pct,
    }


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/holdings")
def list_holdings():
    rows = get_db().execute("SELECT * FROM holdings ORDER BY asset_type, symbol").fetchall()

    results: list[dict[str, Any]] = [{} for _ in rows]
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(rows)))) as pool:
        futures = {
            pool.submit(get_price, row["symbol"], row["asset_type"]): idx
            for idx, row in enumerate(rows)
        }
        for fut in as_completed(futures):
            idx = futures[fut]
            results[idx] = serialize(rows[idx], fut.result())

    totals = {
        "market_value": sum(h["market_value"] for h in results),
        "invested": sum(h["invested"] for h in results),
    }
    totals["gain"] = totals["market_value"] - totals["invested"]
    totals["gain_pct"] = (totals["gain"] / totals["invested"] * 100) if totals["invested"] else 0.0

    breakdown: dict[str, float] = {}
    for h in results:
        breakdown[h["asset_type"]] = breakdown.get(h["asset_type"], 0.0) + h["market_value"]

    return jsonify({"holdings": results, "totals": totals, "breakdown": breakdown})


def _validate_payload(data: dict[str, Any]) -> tuple[str, str, float, float, str, str | None]:
    symbol = (data.get("symbol") or "").strip().upper()
    asset_type = (data.get("asset_type") or "").strip().lower()
    if not symbol:
        raise ValueError("symbol is required")
    if asset_type not in ASSET_TYPES:
        raise ValueError(f"asset_type must be one of {sorted(ASSET_TYPES)}")
    try:
        quantity = float(data.get("quantity", 0))
        cost_basis = float(data.get("cost_basis", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("quantity and cost_basis must be numbers") from exc
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    currency = (data.get("currency") or "USD").strip().upper()
    note = data.get("note")
    return symbol, asset_type, quantity, cost_basis, currency, note


@app.post("/api/holdings")
def create_holding():
    try:
        symbol, asset_type, qty, cost, currency, note = _validate_payload(request.get_json() or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO holdings (symbol, asset_type, quantity, cost_basis, currency, note) VALUES (?,?,?,?,?,?)",
        (symbol, asset_type, qty, cost, currency, note),
    )
    db.commit()
    row = db.execute("SELECT * FROM holdings WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(serialize(row, get_price(symbol, asset_type))), 201


@app.put("/api/holdings/<int:holding_id>")
def update_holding(holding_id: int):
    try:
        symbol, asset_type, qty, cost, currency, note = _validate_payload(request.get_json() or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    db = get_db()
    cur = db.execute(
        "UPDATE holdings SET symbol=?, asset_type=?, quantity=?, cost_basis=?, currency=?, note=? WHERE id=?",
        (symbol, asset_type, qty, cost, currency, note, holding_id),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    row = db.execute("SELECT * FROM holdings WHERE id = ?", (holding_id,)).fetchone()
    return jsonify(serialize(row, get_price(symbol, asset_type)))


@app.delete("/api/holdings/<int:holding_id>")
def delete_holding(holding_id: int):
    db = get_db()
    cur = db.execute("DELETE FROM holdings WHERE id=?", (holding_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"deleted": holding_id})


@app.get("/api/quote")
def quote():
    symbol = (request.args.get("symbol") or "").strip().upper()
    asset_type = (request.args.get("asset_type") or "stock").strip().lower()
    if not symbol or asset_type not in ASSET_TYPES:
        return jsonify({"error": "symbol and valid asset_type required"}), 400
    price = get_price(symbol, asset_type)
    return jsonify({"symbol": symbol, "asset_type": asset_type, "price": price})


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
else:
    init_db()
