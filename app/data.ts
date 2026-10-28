export const DAY_MS = 86_400_000
export const FIRST_CLOUD_DATE = '2024-11-29'

export const record = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

export const utcDate = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error('Expected a valid YYYY-MM-DD date')
  return value
}

export const shiftDate = (date: string, days = 1) =>
  new Date(Date.parse(`${utcDate(date)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10)

export const finiteNumber = (value: unknown): number => {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' &&
      !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    throw new Error('Expected a finite nonnegative number')
  return Number(value)
}

export const nullableNumber = (value: unknown) =>
  value == null ? null : finiteNumber(value)

export const timestamp = (value: unknown): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Expected an ISO timestamp')
  return new Date(value).toISOString()
}

export const realtimeRow = (value: unknown) => {
  const row = record(value)
  return {
    totalCirculation: finiteNumber(row.totalCirculation),
    timestamp: timestamp(row.timestamp ?? record(row.ethereum).timestamp),
  }
}

export interface CloudRow {
  date: string
  total_users: number
  total_vms: number
  running_vms: number
  total_vcpu: number
  running_vcpu: number | null
  active_users: number | null
}

export const cloudRow = (value: unknown): CloudRow => {
  const row = record(value)
  const count = (key: string) => {
    const value = row[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid cloud statistic: ${key}`)
    return value
  }
  return {
    date: utcDate(row.date),
    total_users: count('total_users'),
    total_vms: count('total_vms'),
    running_vms: count('running_vms'),
    total_vcpu: count('total_vcpu'),
    running_vcpu: row.running_vcpu == null ? null : count('running_vcpu'),
    active_users: row.active_users == null ? null : count('active_users'),
  }
}

export const cloudWindow = (lastDate: string, through: string) =>
  Math.min(
    90,
    Math.max(1, (Date.parse(through) - Date.parse(lastDate)) / DAY_MS + 1),
  )

// Older days are recomputed using current VM status, rather than captured at close.
export const cloudSource = (date: string, yesterday: string) =>
  utcDate(date) < utcDate(yesterday) ? 'api-backfill' : 'api'

export const selectCloudRows = (
  value: unknown,
  lastDate: string,
  through: string,
): CloudRow[] => {
  const {data} = record(value)
  if (!Array.isArray(data)) throw new Error('Expected Phala Cloud daily data')
  const rows = data.map(cloudRow)
  const selected: CloudRow[] = []
  for (
    let date = shiftDate(lastDate);
    date <= through;
    date = shiftDate(date)
  ) {
    const matches = rows.filter(
      (row) => row.date === date && row.total_users > 0,
    )
    if (matches.length !== 1)
      throw new Error(
        `Cloud data missing or duplicated ${date}; refusing to skip a date`,
      )
    selected.push(...matches)
  }
  return selected
}

export const captured = (totalVcpu: number, price: number) => {
  finiteNumber(totalVcpu)
  if (!Number.isFinite(price) || price <= 0)
    throw new Error('Invalid PHA price')
  return finiteNumber((totalVcpu * 12 * 50) / price)
}

export const dailyPrices = (value: unknown): Map<string, number> => {
  const {prices} = record(value)
  if (!Array.isArray(prices)) throw new Error('Expected CoinGecko prices')
  const days = new Map<string, {sum: number; count: number}>()
  for (const point of prices) {
    if (!Array.isArray(point) || point.length !== 2)
      throw new Error('Invalid price point')
    const [time, price] = point
    if (
      typeof time !== 'number' ||
      !Number.isSafeInteger(time) ||
      time < 0 ||
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0
    )
      throw new Error('Invalid price point')
    const date = new Date(time).toISOString().slice(0, 10)
    const day = days.get(date) ?? {sum: 0, count: 0}
    day.sum += price
    day.count++
    days.set(date, day)
  }
  return new Map([...days].map(([date, {sum, count}]) => [date, sum / count]))
}

export interface AnalyticsData {
  generatedAt: string
  realtime: {totalCirculation: number; timestamp: string}
  subgraphs: {
    ethereum: {
      deployment: string
      timestamp: string
      vaultImplementation: string
      vaultImplementationReviewed: boolean
      accrualMode: string
    } | null
  }
  circulation: {
    date: string
    ethereum: number | null
    phala: number | null
    khala: number | null
    total: number
  }[]
  chainCirculation: import('./subgraph').ChainDay[]
  vault: import('./subgraph').VaultDay[]
  claims: import('./subgraph').ClaimDay[]
  cloud: {
    date: string
    totalUsers: number
    totalVms: number
    runningVms: number
    totalVcpu: number
    runningVcpu: number | null
    activeUsers: number | null
    captured: number | null
    backfilled: boolean
  }[]
}
