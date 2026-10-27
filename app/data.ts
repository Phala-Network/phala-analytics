export const DAY_MS = 86_400_000
export const FIRST_CIRCULATION_DATE = '2020-04-30'
export const FIRST_CLOUD_DATE = '2024-11-29'
export const VAULT_ADDRESS = '0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0'
export const VAULT_DEPLOY_BLOCK = 21_596_326
export const VAULT_TOPIC =
  '0x2bf582ae7b4e23267f9742193453efcc823164c91b245c2d83075e61e4c5c3e9'

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
    (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) ||
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

export const snapshotRow = (value: unknown, date: string) => {
  const row = record(value)
  if (row.date != null && timestamp(row.date).slice(0, 10) !== utcDate(date))
    throw new Error('Circulation snapshot date mismatch')
  const circulation = (chain: string) =>
    row[chain] == null ? null : finiteNumber(record(row[chain]).circulation)
  const ethereum = circulation('ethereum')
  if (ethereum == null) throw new Error('Missing Ethereum circulation')
  return {
    date: utcDate(date),
    ethereum,
    base: circulation('base'),
    phala: circulation('phala'),
    khala: circulation('khala'),
  }
}

export interface CloudRow {
  date: string
  total_users: number
  total_vms: number
  running_vms: number
  total_vcpu: number
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

export const hexNumber = (value: unknown): number => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error('Invalid RPC quantity')
  const result = Number(BigInt(value))
  if (!Number.isSafeInteger(result))
    throw new Error('RPC quantity out of range')
  return result
}

export interface Settlement {
  block_number: number
  log_index: number
  settled_at: number
  rewards: number
  total_assets: number
}

export const decodeSettlement = (value: unknown): Settlement => {
  const log = record(value)
  if (
    typeof log.address !== 'string' ||
    log.address.toLowerCase() !== VAULT_ADDRESS ||
    !Array.isArray(log.topics) ||
    log.topics.length !== 1 ||
    log.topics[0] !== VAULT_TOPIC ||
    log.removed !== false ||
    typeof log.data !== 'string' ||
    !/^0x[0-9a-f]{192}$/i.test(log.data)
  )
    throw new Error('Invalid RewardsSettled log')
  const settledAt = hexNumber(`0x${log.data.slice(2, 66)}`)
  if (!Number.isFinite(new Date(settledAt * 1000).getTime()))
    throw new Error('Settlement timestamp out of range')
  return {
    block_number: hexNumber(log.blockNumber),
    log_index: hexNumber(log.logIndex),
    settled_at: settledAt,
    rewards: Number(BigInt(`0x${log.data.slice(66, 130)}`)) / 1e18,
    total_assets: Number(BigInt(`0x${log.data.slice(130, 194)}`)) / 1e18,
  }
}

export const halveChunk = (size: number) => {
  if (size <= 1) throw new Error('Vault RPC rejected a single block')
  return Math.max(1, Math.floor(size / 2))
}

// Scan holes rather than MAX(date): an imported tail must not hide earlier gaps.
export const MISSING_CIRCULATION_SQL = `
  WITH RECURSIVE dates(date) AS (
    SELECT ?1 WHERE ?1 <= ?2
    UNION ALL SELECT date(date, '+1 day') FROM dates WHERE date < ?2
  )
  SELECT dates.date FROM dates
  LEFT JOIN circulation_daily USING (date)
  WHERE circulation_daily.date IS NULL ORDER BY dates.date LIMIT 20
`

// Window ordering also resolves multiple settlements in the same block.
export const VAULT_DAILY_SQL = `
  WITH daily AS (
    SELECT date(settled_at, 'unixepoch') AS date, total_assets AS totalAssets,
      SUM(rewards) OVER (PARTITION BY date(settled_at, 'unixepoch')) AS dailyRewards,
      ROW_NUMBER() OVER (
        PARTITION BY date(settled_at, 'unixepoch')
        ORDER BY block_number DESC, log_index DESC
      ) AS position
    FROM vault_settlements
  )
  SELECT date, totalAssets, dailyRewards FROM daily WHERE position = 1 ORDER BY date
`

export interface AnalyticsData {
  generatedAt: string
  realtime: {totalCirculation: number; timestamp: string}
  circulation: {
    date: string
    ethereum: number
    base: number | null
    phala: number | null
    khala: number | null
    total: number
  }[]
  vault: {date: string; totalAssets: number; dailyRewards: number}[]
  cloud: {
    date: string
    totalUsers: number
    totalVms: number
    runningVms: number
    totalVcpu: number
    captured: number | null
    backfilled: boolean
  }[]
}
