# My Precious — Portfolio Tracker

A self-hosted web app to track your stocks, ETFs, crypto, and cash in one place.
Live prices come from free APIs (Yahoo Finance via `yfinance`, Binance public API,
with CoinGecko as a crypto fallback). Net worth and gain/loss recalculate instantly.

## Features

- Add, edit, delete holdings (stocks, ETFs, crypto, cash)
- Live prices with 60-second cache
- Net worth, total invested, total gain, and asset allocation breakdown
- All data stored locally in SQLite (`portfolio.db`)
- No API keys required

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open <http://localhost:5000>.

## Symbol formats

| Asset type | Example                  | Source                       |
|------------|--------------------------|------------------------------|
| stock      | `AAPL`, `MSFT`, `TSLA`   | Yahoo Finance (yfinance)     |
| etf        | `VTI`, `SPY`, `QQQ`      | Yahoo Finance                |
| crypto     | `BTC`, `ETH`, `SOLUSDT`  | Binance (fallback CoinGecko) |
| cash       | `USD`, `EUR`             | Stored at 1.0                |

For crypto, the bare ticker (`BTC`) is auto-paired with `USDT` when querying Binance.

## Tech

- Python 3.10+ / Flask
- SQLite (via `sqlite3` stdlib)
- `yfinance` for stock & ETF quotes
- Binance public ticker API + CoinGecko fallback for crypto
- Vanilla HTML/CSS/JS — no build step

## Configuration

| Env var        | Default          | Purpose                           |
|----------------|------------------|-----------------------------------|
| `PORT`         | `5000`           | HTTP port                         |
| `PORTFOLIO_DB` | `./portfolio.db` | SQLite database file              |

## API

- `GET  /api/holdings` — list with prices and totals
- `POST /api/holdings` — create `{symbol, asset_type, quantity, cost_basis, currency?, note?}`
- `PUT  /api/holdings/<id>` — update
- `DELETE /api/holdings/<id>` — remove
- `GET  /api/quote?symbol=AAPL&asset_type=stock` — quick price lookup

## Notes

This app is for personal use. Yahoo Finance and Binance public endpoints are
unauthenticated and rate-limited; the 60-second price cache keeps you well under
their limits for personal portfolios.
