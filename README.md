# My Precious — Portfolio Tracker

A self-hosted, **iPhone-installable** web app for tracking your stocks, ETFs,
crypto, and cash. Live prices come from free APIs — Yahoo Finance via
`yfinance`, Binance public ticker, with CoinGecko as a fallback — so no API
keys are needed. Net worth and gain/loss recalculate instantly.

It's a Progressive Web App: open the site in Safari on your iPhone, tap
**Share → Add to Home Screen**, and you get an app-icon launcher with no
Safari chrome. A service worker caches the app shell so it opens instantly,
even on a slow connection.

## Features

- Add, edit, delete holdings (stocks, ETFs, crypto, cash)
- Live prices with a 60-second cache, fetched in parallel
- Net worth, total invested, total gain/%, asset allocation breakdown
- Mobile-first dashboard, dark theme, iOS safe-area aware
- Optional password gate (recommended when deployed publicly)
- Installable as a PWA on iPhone & Android

## Quick start (local)

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open <http://localhost:5000>. To test on your phone over Wi-Fi, find your
machine's LAN IP (e.g. `192.168.1.50`) and visit `http://192.168.1.50:5000`
from Safari on your iPhone.

To enable the password gate locally:

```bash
PORTFOLIO_PASSWORD=hunter2 python app.py
```

## Install on your iPhone

1. Open the app's URL in **Safari** (it must be Safari, not Chrome — only
   Safari can install PWAs on iOS).
2. Tap the **Share** button (square with up-arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The app icon now lives on your home screen and opens
   full-screen, no browser bars.

## Deploy to the internet (so you can use it on cellular)

The app currently has no built-in user accounts, so **set
`PORTFOLIO_PASSWORD` before exposing it to the internet**.

### Option A — Render (easiest)

This repo contains a `render.yaml` blueprint.

1. Push this repo to GitHub.
2. Sign in to <https://render.com> → **New** → **Blueprint** → pick this repo.
3. Render reads `render.yaml`, creates the web service and a 1 GB disk for
   SQLite, generates a `SECRET_KEY`, and asks you to fill in
   `PORTFOLIO_PASSWORD`.
4. After deploy, open the URL on your iPhone and Add to Home Screen.

> Render's *free* tier has no persistent disk and sleeps after 15 min idle —
> your data would be wiped on each cold start. The blueprint uses the
> **Starter** tier ($7/mo + $1/mo for the 1 GB disk) so SQLite survives
> restarts. If you want to stay free, see Option B.

### Option B — Fly.io (free volumes)

A `fly.toml` is included.

```bash
brew install flyctl                 # or curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config --name my-precious
fly volumes create data --size 1 --region iad
fly secrets set PORTFOLIO_PASSWORD=your-password \
                SECRET_KEY=$(python -c "import secrets;print(secrets.token_hex(32))")
fly deploy
```

Fly's Hobby plan includes 3 GB of persistent volumes and machines that auto-stop
when idle — well within free limits for a personal tracker.

### Option C — Run on a home machine and tunnel

If you'd rather not pay or sign up:

```bash
pip install -r requirements.txt
PORTFOLIO_PASSWORD=hunter2 gunicorn app:app --bind 0.0.0.0:5000
```

Then expose it via Cloudflare Tunnel, Tailscale Funnel, or `ngrok`. Simplest:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:5000
```

Cloudflare prints a public `https://*.trycloudflare.com` URL — open that on
your iPhone and Add to Home Screen.

## Symbol formats

| Asset type | Example                  | Source                       |
|------------|--------------------------|------------------------------|
| stock      | `AAPL`, `MSFT`, `TSLA`   | Yahoo Finance (yfinance)     |
| etf        | `VTI`, `SPY`, `QQQ`      | Yahoo Finance                |
| crypto     | `BTC`, `ETH`, `SOLUSDT`  | Binance (fallback CoinGecko) |
| cash       | `USD`, `EUR`             | Stored at 1.0                |

Bare crypto tickers (`BTC`) are auto-paired with `USDT` when querying Binance.

## Configuration

| Env var              | Default          | Purpose                                      |
|----------------------|------------------|----------------------------------------------|
| `PORT`               | `5000`           | HTTP port                                    |
| `PORTFOLIO_DB`       | `./portfolio.db` | SQLite database file                         |
| `PORTFOLIO_PASSWORD` | *(unset)*        | If set, requires login. Strongly recommended on the public internet. |
| `SECRET_KEY`         | random per-boot  | Flask session signing key. Set in production so sessions survive restarts. |
| `FORCE_HTTPS`        | `false`          | When `true`, marks session cookie `Secure`. Set on Render/Fly. |

## API

All `/api/*` endpoints require login when `PORTFOLIO_PASSWORD` is set.

- `GET  /api/holdings` — list with prices, totals, breakdown
- `POST /api/holdings` — `{symbol, asset_type, quantity, cost_basis, currency?, note?}`
- `PUT  /api/holdings/<id>` — update
- `DELETE /api/holdings/<id>` — remove
- `GET  /api/quote?symbol=AAPL&asset_type=stock` — quick lookup
- `GET  /healthz` — liveness probe (used by Render/Fly)

## Tech

- Python 3.10+ / Flask + Gunicorn
- SQLite (stdlib `sqlite3`)
- `yfinance` for stocks/ETFs, Binance + CoinGecko for crypto
- Vanilla HTML/CSS/JS — no build step
- PWA: manifest, service worker, iOS-specific meta tags

## Notes

This app is for personal use. Yahoo Finance and Binance public endpoints are
unauthenticated and rate-limited; the 60-second price cache keeps you well
under their limits for personal portfolios. Do not point this at a use case
where it serves many users — both APIs may rate-limit or block you.
