// Dashboard client: fetches /api/data and renders counters, uPlot charts and data tables.
// Served as /app.js; values are inserted with textContent only.

const DAY = 86_400
const integer = new Intl.NumberFormat(undefined, {maximumFractionDigits: 0})
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const utcDay = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
})
const localTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
})

const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const formatNumber = (value) => (value == null ? '–' : integer.format(value))
const toSeconds = (date) => Date.parse(`${date}T00:00:00Z`) / 1000
const formatDay = (date) => utcDay.format(new Date(`${date}T00:00:00Z`))

// Series colors are CSS custom properties. Stacked series are cumulative from the
// first stacked one up; other series are drawn as given.
const STREAMS = {
  circulation: [
    {key: 'total', label: 'Total', color: '--text-secondary'},
    {key: 'ethereum', label: 'Ethereum', color: 1, stack: true},
    {key: 'base', label: 'Base', color: 2, stack: true},
    {key: 'phala', label: 'Phala', color: 3, stack: true},
    {key: 'khala', label: 'Khala', color: 4, stack: true},
  ],
  vault: [{key: 'totalAssets', label: 'Total assets', color: 1, area: true}],
  // Each day's total is held across that day, like a gapless bar.
  rewards: [
    {
      key: 'dailyRewards',
      label: 'Daily rewards',
      color: 1,
      area: true,
      step: true,
    },
  ],
  users: [{key: 'totalUsers', label: 'Users', color: 1, area: true}],
  vms: [
    {key: 'totalVms', label: 'Total VMs', color: 1, area: true},
    {key: 'runningVms', label: 'Running VMs', color: 2, area: true},
  ],
  vcpu: [{key: 'totalVcpu', label: 'Total vCPUs', color: 1, area: true}],
  captured: [
    {key: 'captured', label: 'Annual revenue in PHA', color: 1, area: true},
  ],
}

// Charts whose values the upstream recomputes for backfilled days (Amendment 1).
const BACKFILL_AFFECTED = new Set(['users', 'vms'])

const status = document.getElementById('status')
const dashboard = document.getElementById('dashboard')
const charts = new Map()

const setText = (selector, text) => {
  for (const element of document.querySelectorAll(selector))
    element.textContent = text
}

const latest = (rows, key) => {
  for (let index = rows.length - 1; index >= 0; index--)
    if (rows[index][key] != null) return rows[index]
  return undefined
}

const setStat = (name, rows, key) => {
  const row = latest(rows, key)
  setText(`[data-value="${name}"]`, formatNumber(row?.[key]))
  setText(`[data-as-of="${name}"]`, row ? `as of ${formatDay(row.date)}` : '')
}

// Groups consecutive backfilled days into [first, last] date ranges.
const backfillRanges = (rows) => {
  const ranges = []
  for (const row of rows) {
    if (!row.backfilled) continue
    const last = ranges.at(-1)
    if (last && toSeconds(row.date) - toSeconds(last[1]) === DAY)
      last[1] = row.date
    else ranges.push([row.date, row.date])
  }
  return ranges
}

const describeRange = ([first, last]) =>
  first === last ? formatDay(first) : `${formatDay(first)} – ${formatDay(last)}`

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const withAlpha = (hex, alpha) => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${value >> 16} ${(value >> 8) & 255} ${value & 255} / ${alpha})`
}

const summary = (rows, series) => {
  if (rows.length === 0) return 'No data yet.'
  const range = `${formatDay(rows[0].date)} to ${formatDay(rows.at(-1).date)}`
  const values = series
    .map(({key, label}) => {
      const row = latest(rows, key)
      return row ? `${label} ${formatNumber(row[key])}` : null
    })
    .filter(Boolean)
    .join(', ')
  return `Chart of ${series.map(({label}) => label).join(', ')} from ${range}. Latest: ${values}.`
}

const renderChart = (figure, rows, series, ranges) => {
  const target = figure.querySelector('[data-plot]')
  charts.get(target)?.destroy()
  charts.delete(target)
  target.replaceChildren()
  target.setAttribute('role', 'img')
  target.setAttribute('aria-label', summary(rows, series))
  const uPlot = globalThis.uPlot
  if (typeof uPlot !== 'function' || rows.length === 0) {
    const message = document.createElement('p')
    message.className = 'plot-message'
    message.textContent =
      rows.length === 0
        ? 'No data yet.'
        : 'The chart could not be loaded. The data table below has every value.'
    target.append(message)
    return
  }
  const colors = series.map(({color}) =>
    cssVar(typeof color === 'number' ? `--series-${color}` : color),
  )
  const axis = {
    stroke: cssVar('--axis'),
    font: '12px system-ui, -apple-system, "Segoe UI", sans-serif',
    grid: {stroke: cssVar('--grid'), width: 1},
    ticks: {stroke: cssVar('--baseline'), width: 1, size: 4},
  }
  const shade = cssVar('--backfill')
  const surface = cssVar('--surface')
  const sums = rows.map(() => 0)
  const data = [
    rows.map(({date}) => toSeconds(date)),
    ...series.map(({key, stack}) =>
      rows.map((row, index) => {
        if (!stack) return row[key]
        sums[index] += row[key] ?? 0
        return sums[index]
      }),
    ),
  ]
  // Each stacked series fills down to the stacked series below it.
  const stacked = series.flatMap(({stack}, index) => (stack ? [index + 1] : []))
  const bands = stacked.slice(1).map((upper, index) => ({
    series: [upper, stacked[index]],
  }))
  const plot = new uPlot(
    {
      width: target.clientWidth,
      height: 240,
      tzDate: (seconds) => uPlot.tzDate(new Date(seconds * 1000), 'Etc/UTC'),
      scales: {y: {range: (_, __, max) => [0, max > 0 ? max * 1.05 : 1]}},
      series: [
        {
          label: 'Date',
          value: (_, seconds) =>
            seconds == null ? '–' : utcDay.format(new Date(seconds * 1000)),
        },
        ...series.map(({key, label, area, stack, step}, index) => ({
          label,
          stroke: colors[index],
          width: stack ? 1 : 2,
          fill: stack
            ? withAlpha(colors[index], 0.45)
            : area
              ? withAlpha(colors[index], step ? 0.3 : 0.1)
              : undefined,
          paths: step ? uPlot.paths.stepped({align: 1}) : undefined,
          points: {show: false},
          // Legends show each row's own value, not the stacked sum.
          value: (_, __, ___, row) => formatNumber(rows[row]?.[key]),
        })),
      ],
      bands,
      axes: [
        {...axis},
        {
          ...axis,
          size: 52,
          values: (_, ticks) => ticks.map((tick) => compact.format(tick)),
        },
      ],
      legend: {
        markers: {width: 0, fill: (_, index) => colors[index - 1]},
      },
      cursor: {
        y: false,
        points: {
          size: 9,
          width: 2,
          stroke: () => surface,
          fill: (_, index) => colors[index - 1],
        },
      },
      hooks: {
        // Without a hovered point, the legend shows the latest values.
        setCursor: [
          (chart) => {
            if (chart.cursor.idx == null)
              chart.setLegend({idx: rows.length - 1}, false)
          },
        ],
        drawClear: [
          (chart) => {
            if (ranges.length === 0) return
            const {left, top, width, height} = chart.bbox
            chart.ctx.save()
            chart.ctx.fillStyle = shade
            for (const [first, last] of ranges) {
              const start = Math.max(
                left,
                chart.valToPos(toSeconds(first) - DAY / 2, 'x', true),
              )
              const end = Math.min(
                left + width,
                chart.valToPos(toSeconds(last) + DAY / 2, 'x', true),
              )
              if (end > start)
                chart.ctx.fillRect(start, top, end - start, height)
            }
            chart.ctx.restore()
          },
        ],
      },
    },
    data,
    target,
  )
  plot.setLegend({idx: rows.length - 1}, false)
  charts.set(target, plot)
}

const renderTable = (figure) => {
  const name = figure.dataset.chart
  const {rows} = state[name]
  const series = STREAMS[name]
  const flagBackfill = BACKFILL_AFFECTED.has(name)
  const wrap = figure.querySelector('.table-wrap')
  const table = document.createElement('table')
  const head = table.createTHead().insertRow()
  for (const label of ['Date', ...series.map((item) => item.label)]) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = label
    head.append(cell)
  }
  const body = table.createTBody()
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    const line = body.insertRow()
    const date = document.createElement('th')
    date.scope = 'row'
    date.textContent = formatDay(row.date)
    line.append(date)
    if (flagBackfill && row.backfilled) {
      line.dataset.backfilled = ''
      date.textContent += ' (recomputed)'
    }
    for (const {key} of series)
      line.insertCell().textContent = formatNumber(row[key])
  }
  wrap.replaceChildren(table)
}

let state

const renderCharts = () => {
  if (!state) return
  for (const figure of document.querySelectorAll('[data-chart]')) {
    const name = figure.dataset.chart
    const {rows, ranges} = state[name]
    renderChart(figure, rows, STREAMS[name], ranges)
  }
}

const render = (data) => {
  setText(
    '[data-value="circulation"]',
    formatNumber(data.realtime.totalCirculation),
  )
  setText(
    '[data-as-of="circulation"]',
    `as of ${localTime.format(new Date(data.realtime.timestamp))}`,
  )
  setStat('vault', data.vault, 'totalAssets')
  setStat('stakers', data.vault, 'stakers')
  const vault = data.vault.at(-1)
  if (vault && !vault.vaultImplementationReviewed) {
    setText('[data-value="apr"]', '–')
    setText('[data-as-of="apr"]', 'Hidden while a Vault upgrade is reviewed')
  } else {
    setText('[data-value="apr"]', vault ? percent.format(vault.apr) : '–')
    setText('[data-as-of="apr"]', vault ? `as of ${formatDay(vault.date)}` : '')
  }

  // Claim rows are daily flows; the counters show their totals.
  const sum = (...keys) =>
    data.claims.reduce(
      (total, row) => keys.reduce((part, key) => part + row[key], total),
      0,
    )
  const lastClaimDay = data.claims.at(-1)
  const breakdown = (khala, phala, format) =>
    lastClaimDay
      ? `Khala ${format(khala)} · Phala ${format(phala)}, through ${formatDay(lastClaimDay.flowDate)}`
      : ''
  const claims = [sum('khalaClaimCount'), sum('phalaClaimCount')]
  const claimed = [
    sum('khalaFree', 'khalaStaked'),
    sum('phalaFree', 'phalaStaked'),
  ]
  setText(
    '[data-value="claimCount"]',
    formatNumber(lastClaimDay && claims[0] + claims[1]),
  )
  setText('[data-as-of="claimCount"]', breakdown(...claims, formatNumber))
  setText(
    '[data-value="claimed"]',
    formatNumber(lastClaimDay && claimed[0] + claimed[1]),
  )
  setText('[data-as-of="claimed"]', breakdown(...claimed, compact.format))
  setStat('users', data.cloud, 'totalUsers')
  setStat('totalVms', data.cloud, 'totalVms')
  setStat('runningVms', data.cloud, 'runningVms')
  setStat('vcpu', data.cloud, 'totalVcpu')
  setStat('captured', data.cloud, 'captured')

  const ranges = backfillRanges(data.cloud)
  state = {
    circulation: {rows: data.circulation, ranges: []},
    vault: {rows: data.vault, ranges: []},
    // Daily flows belong to the UTC day before each midnight snapshot.
    rewards: {
      rows: data.vault.map(({flowDate, dailyRewards}) => ({
        date: flowDate,
        dailyRewards,
      })),
      ranges: [],
    },
  }
  for (const name of ['users', 'vms', 'vcpu', 'captured'])
    state[name] = {
      rows: data.cloud,
      ranges: BACKFILL_AFFECTED.has(name) ? ranges : [],
    }

  const note = document.getElementById('backfill-note')
  note.hidden = ranges.length === 0
  note.textContent = `Shaded days (${ranges.map(describeRange).join(', ')}) were backfilled from history that Phala Cloud recomputes using each VM’s and user’s current status, so running VMs and users are understated for those days.`

  renderCharts()
  for (const figure of document.querySelectorAll('[data-chart]'))
    if (figure.querySelector('[data-table]').open) renderTable(figure)
  status.textContent = `Updated ${localTime.format(new Date(data.generatedAt))}`
}

const showError = () => {
  status.dataset.state = 'error'
  status.textContent = 'Analytics data is temporarily unavailable.'
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = 'Retry'
  retry.addEventListener('click', load)
  status.append(retry)
}

async function load() {
  delete status.dataset.state
  status.textContent = 'Loading data…'
  dashboard.setAttribute('aria-busy', 'true')
  try {
    const response = await fetch('/api/data', {
      headers: {Accept: 'application/json'},
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    render(await response.json())
  } catch (error) {
    console.error('Failed to load analytics data', error)
    showError()
  } finally {
    dashboard.setAttribute('aria-busy', 'false')
  }
}

const resize = new ResizeObserver((entries) => {
  for (const {target} of entries) {
    const plot = charts.get(target)
    if (plot && target.clientWidth !== plot.width)
      plot.setSize({width: target.clientWidth, height: 240})
  }
})
for (const figure of document.querySelectorAll('[data-chart]')) {
  resize.observe(figure.querySelector('[data-plot]'))
  // Tables are built on first open; render() refreshes any already open.
  const details = figure.querySelector('[data-table]')
  details.addEventListener('toggle', () => {
    if (details.open && state && !figure.querySelector('.table-wrap table'))
      renderTable(figure)
  })
}

matchMedia('(prefers-color-scheme: dark)').addEventListener(
  'change',
  renderCharts,
)

load()
