import CLIENT from './client.js' with {type: 'text'}
import STYLE from './style.css' with {type: 'text'}

// uPlot is loaded from jsDelivr, pinned to the exact npm build and checked with SRI.
// The CSP in index.ts allows these two URLs only.
export const UPLOT_SCRIPT =
  'https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.iife.min.js'
export const UPLOT_STYLE =
  'https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.min.css'
const UPLOT_SCRIPT_SRI =
  'sha384-Gx3t0zdBAuQOuvvmaLZj7HKEiSgWTAs+VdtNY7wt19QDPTDQjFIwAuXDj0zeN00c'
const UPLOT_STYLE_SRI =
  'sha384-IfV0B7MIOYuO95kO9G5ySKPz/85zqFNOAs8iy4tkK5zd9izhJAB8b7lHrwYqqmYE'

// Phala mark from https://phala.com/home/logo.svg.
const MARK = `<path d="M0 7.68C0 4.99175 0 3.64762 0.523169 2.62085C0.983362 1.71767 1.71767 0.983361 2.62085 0.523169C3.64762 0 4.99175 0 7.68001 0H40.32C43.0083 0 44.3524 0 45.3792 0.523169C46.2824 0.983361 47.0167 1.71767 47.4769 2.62085C48 3.64762 48 4.99175 48 7.68V40.32C48 43.0083 48 44.3524 47.4769 45.3792C47.0167 46.2823 46.2824 47.0166 45.3792 47.4768C44.3524 48 43.0083 48 40.32 48H7.68001C4.99175 48 3.64762 48 2.62085 47.4768C1.71767 47.0166 0.983362 46.2823 0.523169 45.3792C0 44.3524 0 43.0083 0 40.32V7.68Z" fill="#CDFA50"/><path d="M11.2 29.3337H16.5333V37.3337H11.2V29.3337Z" fill="#1E2119"/><path d="M32.5333 16.0003H37.8667V24.0003H32.5333V16.0003Z" fill="#1E2119"/><path d="M16.5333 24.0003H32.5333V29.3337H16.5333V24.0003Z" fill="#1E2119"/><path d="M11.2 10.667H32.5333V16.0003H16.5333V24.0003L11.2 23.9337V10.667Z" fill="#1E2119"/>`

const WORDMARK = `<path d="M71.8631 21.5534C71.8631 25.2787 69.5299 27.4266 65.459 27.4266H62.2804V31.9977H58.6666V15.9998H65.459C69.5299 15.9998 71.8631 18.0111 71.8631 21.5534ZM68.4325 21.6676C68.4325 19.8852 67.2886 18.9941 65.2763 18.9941H62.2804V24.4105H65.2763C67.2886 24.4105 68.4325 23.4958 68.4325 21.6676Z" fill="currentColor"/><path d="M77.5266 15.9998V23.999H84.7766V15.9998H88.3883V31.9977H84.7766V27.1982H77.5266V31.9977H73.916V15.9998H77.5266Z" fill="currentColor"/><path d="M102.261 28.798H94.9242L93.6297 31.9998H89.9017L96.8542 16.002H100.582L107.421 31.9998H103.555L102.261 28.798ZM100.974 25.5962L98.6133 19.7711L96.2332 25.5984L100.974 25.5962Z" fill="currentColor"/><path d="M132.71 28.798H125.373L124.078 31.9998H120.35L127.303 16.002H131.031L137.867 31.9998H134.001L132.71 28.798ZM131.423 25.5962L129.064 19.7689L126.684 25.5962H131.423Z" fill="currentColor"/><path d="M112.686 15.9998V28.8439H119.547V31.9977H109.072V15.9998H112.686Z" fill="currentColor"/>`

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${MARK}</svg>`

const chart = (
  id: string,
  title: string,
  description: string,
) => `<figure class="card" data-chart="${id}">
          <figcaption><h3 id="${id}-title">${title}</h3><p class="caption">${description}</p></figcaption>
          <div class="plot" data-plot></div>
          <details data-table><summary>Show data table</summary><div class="table-wrap" tabindex="0" role="region" aria-labelledby="${id}-title"></div></details>
        </figure>`

const stat = (key: string, label: string, unit = '') => `<div class="stat">
            <dt>${label}</dt>
            <dd><span class="value" data-value="${key}">–</span>${unit && `<span class="unit">${unit}</span>`}<span class="as-of" data-as-of="${key}"></span></dd>
          </div>`

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phala Analytics</title>
<meta name="description" content="Public statistics for the $PHA token, the $PHA Vault, sunset claims and Phala Cloud.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${UPLOT_STYLE}" integrity="${UPLOT_STYLE_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer">
<link rel="stylesheet" href="/app.css">
<script src="${UPLOT_SCRIPT}" integrity="${UPLOT_SCRIPT_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer" defer></script>
<script src="/app.js" type="module"></script>
</head>
<body>
<div class="page">
  <header class="masthead">
    <svg class="logo" viewBox="0 0 138 48" role="img" aria-label="Phala">${MARK}${WORDMARK}</svg>
    <h1>Phala Analytics</h1>
    <p class="lede">Phala: The New Cloud for Confidential AI. Hardware-secured compute platform that delivers verifiable AI with enterprise-grade privacy. Deploy confidential AI models with TEE protection in minutes.</p>
    <ul class="links" aria-label="Phala links">
      <li><a href="https://phala.com">Website</a></li>
      <li><a href="https://x.com/PhalaNetwork">X</a></li>
      <li><a href="https://discord.gg/phala-network">Discord</a></li>
    </ul>
    <p class="status" id="status" role="status">Loading data…</p>
    <noscript><p class="status">Charts and figures need JavaScript. The raw data is available as <a href="/api/data">JSON</a>.</p></noscript>
  </header>
  <main id="dashboard" aria-busy="true">
    <section aria-labelledby="token">
      <div class="section-head">
        <h2 id="token">$PHA Token</h2>
        <p><a href="https://coinmarketcap.com/currencies/phala-network/">CoinMarketCap</a></p>
      </div>
      <div class="split">
        <dl class="stats card">
          ${stat('circulation', 'Circulating supply', 'PHA')}
        </dl>
        ${chart('circulation', 'Circulating supply', 'By chain at 00:00 UTC each day, stacked (PHA)')}
      </div>
    </section>
    <section aria-labelledby="vault">
      <div class="section-head">
        <h2 id="vault">$PHA Vault</h2>
        <p>Stake $PHA on Ethereum to get rewards: <a href="https://app.phala.network/staking">app.phala.network/staking</a></p>
      </div>
      <dl class="stats">
        <div class="card wide">${stat('vault', 'Total assets', 'PHA')}</div>
        <div class="card">${stat('apr', 'APR')}</div>
        <div class="card">${stat('stakers', 'Stakers')}</div>
      </dl>
      <div class="charts">
        ${chart('vault', 'Total assets', 'At 00:00 UTC each day (PHA)')}
        ${chart('rewards', 'Daily rewards', 'Rewards accrued each UTC day (PHA)')}
      </div>
    </section>
    <section aria-labelledby="claims">
      <div class="section-head">
        <h2 id="claims">Sunset claims</h2>
        <p>PHA claimed on Ethereum by former Khala and Phala chain holders</p>
      </div>
      <dl class="stats">
        <div class="card wide">${stat('claimCount', 'Claims')}</div>
        <div class="card wide">${stat('claimed', 'PHA claimed', 'PHA')}</div>
      </dl>
    </section>
    <section aria-labelledby="cloud">
      <div class="section-head">
        <h2 id="cloud">Phala Cloud</h2>
      </div>
      <dl class="stats">
        <div class="card">${stat('users', 'Users')}</div>
        <div class="card">${stat('totalVms', 'Total VMs')}</div>
        <div class="card">${stat('runningVms', 'Running VMs')}</div>
        <div class="card">${stat('vcpu', 'Total vCPU')}</div>
        <div class="card wide">${stat('captured', 'Annual revenue in PHA', 'PHA')}</div>
      </dl>
      <div class="charts">
        ${chart('users', 'Users', 'Daily total')}
        ${chart('vms', 'VMs', 'Total and running, daily')}
        ${chart('vcpu', 'Total vCPUs', 'Daily total')}
        ${chart('captured', 'Annual revenue in PHA', 'Total vCPUs × 12 × $50, converted at that day’s PHA price')}
      </div>
      <p class="note" id="backfill-note" hidden></p>
    </section>
  </main>
  <footer>
    <p class="footer-text">Daily values are UTC days. Sources: Phala subgraphs on Ethereum and Base, archived Phala and Khala chain history, the $PHA circulation API, Phala Cloud usage statistics, and daily PHA prices (Dune through September 22, 2026, CoinGecko after). Data refreshes hourly.</p>
    <p class="footer-text"><a href="/api/data">Download the data (JSON)</a></p>
  </footer>
</div>
</body>
</html>`

export const ASSETS: Record<string, {body: string; type: string}> = {
  '/': {body: PAGE, type: 'text/html; charset=utf-8'},
  '/app.js': {body: CLIENT, type: 'text/javascript; charset=utf-8'},
  '/app.css': {body: STYLE, type: 'text/css; charset=utf-8'},
  '/favicon.svg': {body: FAVICON, type: 'image/svg+xml'},
}
