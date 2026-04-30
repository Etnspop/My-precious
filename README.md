# My Precious — Portfolio Tracker

A tiny **iPhone-installable** portfolio tracker for stocks, ETFs, crypto, and
cash. Live prices come from free APIs (Binance + CoinGecko for crypto, Yahoo
Finance + Stooq for stocks) — no keys, no signup, no backend.

**Your data never leaves your device.** Holdings are stored in your phone's
own browser storage. Two people opening the same URL each get their own
private portfolio. Nothing is uploaded anywhere.

## Live demo / share link

Once GitHub Pages is enabled (see below), the app is published at:

```
https://<your-github-username>.github.io/My-precious/
```

Share that URL with anyone — each person stores their own portfolio in their
own phone.

## Install on your iPhone

1. Open the URL above in **Safari** (must be Safari — only Safari can install
   PWAs on iOS).
2. Tap the **Share** button (square with up-arrow).
3. Tap **Add to Home Screen** → **Add**.
4. The app icon now sits on your home screen and opens full-screen, no browser
   chrome. It even works briefly offline thanks to the service worker.

The same flow works on Android (Chrome → menu → "Add to Home screen").

## Features

- Add, edit, delete holdings (stocks, ETFs, crypto, cash)
- Live prices in the browser, 60s cache, parallel fetch
- Net worth, total invested, total gain / %, asset allocation bars
- Mobile-first dark UI with iOS safe-area insets and a stacked card layout on
  small screens
- **Export** your portfolio to a JSON file and **import** it back — that's
  how you back up or move to another device
- Fully offline-capable shell (PWA service worker)
- 100 % static — no server, no database, no accounts

## Symbol formats

| Asset type | Example                  | Source                                  |
|------------|--------------------------|-----------------------------------------|
| stock      | `AAPL`, `MSFT`, `TSLA`   | Yahoo Finance (Stooq fallback)          |
| etf        | `VTI`, `SPY`, `QQQ`      | Yahoo Finance (Stooq fallback)          |
| crypto     | `BTC`, `ETH`, `SOLUSDT`  | Binance (CoinGecko fallback)            |
| cash       | `USD`, `EUR`             | Stored at 1.0                           |

For crypto, bare tickers (`BTC`) are auto-paired with `USDT` for Binance.

## Backup, move, share data

The app stores everything in `localStorage` under the key
`myprecious.holdings.v1`. To **back up** or **move to a new phone**:

1. Open the **⋯ menu** → **Export portfolio (JSON)** — saves a `.json` file.
2. On the new device, open the same app URL → **⋯ menu** → **Import
   portfolio (JSON)** — pick the file.

You can also share that JSON file with someone else as a starter portfolio.

## Run locally

The whole app is just static files. From the project root:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then visit <http://localhost:8000>. To test on your phone over Wi-Fi, use
your machine's LAN IP, e.g. `http://192.168.1.50:8000`.

## Publish on GitHub Pages

This repo includes a workflow at `.github/workflows/pages.yml` that
automatically deploys the site whenever you push to `main`.

One-time setup:

1. Push to GitHub (the `main` branch).
2. Open **Settings → Pages** in the repo on GitHub.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. The next push to `main` deploys to
   `https://<your-username>.github.io/<repo-name>/`.

Custom domain? Add a `CNAME` file with your domain, configure DNS, and Pages
will serve it over HTTPS automatically.

## File map

```
index.html             single-page app shell
app.js                 storage, price fetching, rendering, export/import
style.css              dark / mobile-first styles
manifest.json          PWA metadata
sw.js                  service worker (offline shell cache)
icon-192.png           PWA icon (also used as favicon)
icon-512.png           PWA icon (large)
icon-maskable-512.png  PWA maskable icon (Android adaptive)
apple-touch-icon.png   iOS home-screen icon (180×180)
.github/workflows/
  pages.yml            auto-deploy to GitHub Pages
```

## Notes & limitations

- **Stock prices** come from public Yahoo / Stooq endpoints in the browser.
  These are unauthenticated and rate-limited; for personal use the 60-second
  in-memory cache keeps you well under the limits. Yahoo's CORS policy can
  occasionally change — the Stooq fallback covers most US listings if Yahoo
  blocks you.
- **Crypto** uses Binance's public ticker. A few regions block
  `api.binance.com`; the CoinGecko fallback handles those cases.
- **Storage** is per-browser-per-device. Clearing your Safari data wipes the
  portfolio. Use Export periodically to keep a backup.
- This is a personal-use tool, not a brokerage. Numbers are informational and
  may lag the market.
