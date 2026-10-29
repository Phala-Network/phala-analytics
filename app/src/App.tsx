import {DownloadIcon, InfoIcon, TriangleAlertIcon} from 'lucide-react'
import {type ReactNode, useMemo} from 'react'
import {ChartCard} from '@/components/chart-card'
import {MetricCard} from '@/components/metric-card'
import {PhalaLogo} from '@/components/phala-logo'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {Separator} from '@/components/ui/separator'
import {useAnalytics} from '@/hooks/use-analytics'
import {
  dayTime,
  formatCompact,
  formatDay,
  formatNumber,
  formatPercent,
  formatTimestamp,
} from '@/lib/format'
import {
  latest,
  type Row,
  type Series,
  toRows,
  weeklyRewards,
} from '@/lib/series'
import type {AnalyticsData} from '../worker/data'

// Chart colors are one hue from light (--chart-1) to dark (--chart-5); series
// that share a chart use steps far apart.
const CIRCULATION: Series[] = [
  {key: 'ethereum', label: 'Ethereum', color: 'var(--chart-2)', stack: true},
  {key: 'phala', label: 'Phala', color: 'var(--chart-5)', stack: true},
  {key: 'khala', label: 'Khala', color: 'var(--chart-1)', stack: true},
  {key: 'total', label: 'Total'},
]
const VAULT: Series[] = [
  {key: 'totalAssets', label: 'Total assets', color: 'var(--chart-2)'},
]
const WEEKLY_REWARDS: Series[] = [
  {key: 'rewards', label: 'Rewards', color: 'var(--chart-2)'},
]
const DAILY_REWARDS: Series[] = [{key: 'dailyRewards', label: 'Daily rewards'}]
const USERS: Series[] = [
  {key: 'totalUsers', label: 'Users', color: 'var(--chart-2)'},
]
const VMS: Series[] = [
  {key: 'totalVms', label: 'Total VMs', color: 'var(--chart-2)'},
  {key: 'runningVms', label: 'Running VMs', color: 'var(--chart-5)'},
]
const VCPU: Series[] = [
  {key: 'totalVcpu', label: 'Total vCPUs', color: 'var(--chart-2)'},
]
const REVENUE: Series[] = [
  {key: 'captured', label: 'Annual revenue', color: 'var(--chart-2)'},
]

const LINKS = [
  {href: 'https://phala.com', label: 'Website'},
  {href: 'https://phala.com/x', label: 'X'},
  {href: 'https://phala.com/discord', label: 'Discord'},
]

// Section-cards grid from dashboard-01, verbatim.
const CARDS =
  'grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card'
// The same grid with two columns, for two cards per row.
const CARDS_2 =
  'grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 dark:*:data-[slot=card]:bg-card'
// Chart cards use two columns at the dashboard grid breakpoint.
const CHARTS = 'grid grid-cols-1 gap-4 px-4 lg:px-6 @5xl/main:grid-cols-2'

const derive = (data: AnalyticsData) => {
  const vault = data.vault.at(-1)
  const reviewed = vault?.vaultImplementationReviewed !== false
  const vaultAsOf = vault && `As of ${formatDay(vault.date)}`
  const total = (...keys: (keyof AnalyticsData['claims'][number])[]) =>
    data.claims.reduce(
      (sum, row) => keys.reduce((part, key) => part + Number(row[key]), sum),
      0,
    )
  const lastClaim = data.claims.at(-1)
  const cloud = (key: keyof AnalyticsData['cloud'][number]) => {
    const row = latest(data.cloud, key)
    return {
      value: row ? formatNumber(Number(row[key])) : '–',
      asOf: row && `As of ${formatDay(row.date)}`,
    }
  }
  return {
    updated: formatTimestamp(data.generatedAt),
    circulation: formatNumber(data.realtime.totalCirculation),
    circulationAsOf: formatTimestamp(data.realtime.timestamp),
    vault: {
      reviewed,
      vaultAsOf,
      totalAssets: vault ? formatNumber(vault.totalAssets) : '–',
      apr: vault && reviewed ? formatPercent(vault.apr) : '–',
      stakers: vault ? formatNumber(vault.stakers) : '–',
    },
    claims: lastClaim && {
      through: `Through ${formatDay(lastClaim.flowDate)}`,
      count: [total('khalaClaimCount'), total('phalaClaimCount')] as const,
      amount: [
        total('khalaFree', 'khalaStaked'),
        total('phalaFree', 'phalaStaked'),
      ] as const,
    },
    cloud: {
      users: cloud('totalUsers'),
      totalVms: cloud('totalVms'),
      runningVms: cloud('runningVms'),
      vcpu: cloud('totalVcpu'),
      captured: cloud('captured'),
    },
    rows: {
      circulation: toRows(
        data.circulation,
        ({ethereum, phala, khala, total}) => ({ethereum, phala, khala, total}),
      ),
      vault: toRows(data.vault, ({totalAssets}) => ({totalAssets})),
      weeklyRewards: weeklyRewards(data.vault),
      dailyRewards: data.vault.map(({flowDate, dailyRewards}) => ({
        date: flowDate,
        time: dayTime(flowDate),
        dailyRewards,
      })),
      cloud: toRows(
        data.cloud,
        ({totalUsers, totalVms, runningVms, totalVcpu, captured}) => ({
          totalUsers,
          totalVms,
          runningVms,
          totalVcpu,
          captured,
        }),
      ),
    } satisfies Record<string, Row[]>,
  }
}

// Heading and description from the shadcn/ui tasks example; the column gap
// and padding are the dashboard-01 page's.
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1 px-4 lg:px-6">
        <h2 id={id} className="text-2xl font-semibold tracking-tight">
          {title}
        </h2>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

// Link from the shadcn/ui typography example.
const Link = ({href, children}: {href: string; children: ReactNode}) => (
  <a
    href={href}
    className="font-medium text-primary underline underline-offset-4"
  >
    {children}
  </a>
)

export function App() {
  const {state, retry} = useAnalytics()
  const view = useMemo(
    () => (state.status === 'ready' ? derive(state.data) : undefined),
    [state],
  )
  const claims = view?.claims

  return (
    <>
      {/* SiteHeader from dashboard-01; the links follow its GitHub button.
          The shared max width follows the shadcn/ui site's --breakpoint-2xl page width. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b">
        <div className="mx-auto flex w-full max-w-(--breakpoint-2xl) items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <PhalaLogo className="h-6 w-auto" />
          <Separator
            orientation="vertical"
            className="mx-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <h1 className="text-base font-medium">
            <span className="sr-only">Phala </span>Analytics
          </h1>
          <nav
            aria-label="Phala links"
            className="ml-auto flex items-center gap-2"
          >
            {LINKS.map(({href, label}) => (
              <Button key={href} variant="ghost" asChild size="sm">
                <a href={href} className="dark:text-foreground">
                  {label}
                </a>
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <main
        className="@container/main mx-auto flex w-full max-w-(--breakpoint-2xl) flex-1 flex-col gap-2"
        aria-busy={state.status === 'loading'}
      >
        <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
          <div className="px-4 lg:px-6">
            <p className="text-xl text-muted-foreground">
              Phala: The New Cloud for Confidential AI. Hardware-secured compute
              platform that delivers verifiable AI with enterprise-grade
              privacy. Deploy confidential AI models with TEE protection in
              minutes.
            </p>
          </div>
          {state.status === 'error' && (
            <div className="px-4 lg:px-6">
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>
                  Analytics data is temporarily unavailable.
                </AlertTitle>
                <AlertAction>
                  <Button size="xs" variant="default" onClick={retry}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          )}

          {/* Overview: the block's four section cards. */}
          <div className={CARDS}>
            <MetricCard
              label="Circulating supply (PHA)"
              value={view?.circulation}
              secondary={view && `As of ${view.circulationAsOf}`}
            />
            <MetricCard
              label="Vault total assets (PHA)"
              value={view?.vault.totalAssets}
              secondary={view?.vault.vaultAsOf}
            />
            <MetricCard
              label="Vault APR"
              value={view?.vault.apr}
              action={
                view &&
                !view.vault.reviewed && (
                  <Badge variant="outline">Under review</Badge>
                )
              }
              secondary={view?.vault.vaultAsOf}
            />
            <MetricCard
              label="Vault stakers"
              value={view?.vault.stakers}
              secondary={view?.vault.vaultAsOf}
            />
          </div>

          <Section
            id="token"
            title="$PHA Token"
            description={
              <Link href="https://coinmarketcap.com/currencies/phala-network/">
                CoinMarketCap
              </Link>
            }
          >
            <div className="px-4 lg:px-6">
              <ChartCard
                title="Circulating supply"
                description="By chain at 00:00 UTC each day, stacked (PHA)"
                rows={view?.rows.circulation}
                series={CIRCULATION}
                footer="Ethereum plus the Phala and Khala chains until their sunset. Base PHA is counted through the Ethereum Portal escrow."
              />
            </div>
          </Section>

          <Section
            id="vault"
            title="$PHA Vault"
            description={
              <>
                Stake $PHA on Ethereum to get rewards:{' '}
                <Link href="https://app.phala.network/staking">
                  app.phala.network/staking
                </Link>
              </>
            }
          >
            {view && !view.vault.reviewed && (
              <div className="px-4 lg:px-6">
                <Alert role="note">
                  <InfoIcon />
                  <AlertTitle>Vault upgrade under review</AlertTitle>
                  <AlertDescription>
                    The Vault runs an implementation that has not been reviewed
                    yet. Its figures are shown as indexed, and APR is hidden
                    until the review is complete.
                  </AlertDescription>
                </Alert>
              </div>
            )}
            <div className={CHARTS}>
              <ChartCard
                title="Total assets"
                description="At 00:00 UTC each day (PHA)"
                rows={view?.rows.vault}
                series={VAULT}
              />
              <ChartCard
                title="Weekly rewards"
                description="Weekly totals, Monday to Sunday UTC (PHA)"
                rows={view?.rows.weeklyRewards}
                series={WEEKLY_REWARDS}
                bars={{periodLabel: 'Week of'}}
                table={{rows: view?.rows.dailyRewards, series: DAILY_REWARDS}}
              />
            </div>
          </Section>

          <Section
            id="claims"
            title="Sunset claims"
            description="PHA claimed on Ethereum by former Khala and Phala chain holders"
          >
            <div className={CARDS_2}>
              <MetricCard
                label="Claims"
                value={
                  view &&
                  (claims
                    ? formatNumber(claims.count[0] + claims.count[1])
                    : '–')
                }
                primary={
                  claims &&
                  `Khala ${formatNumber(claims.count[0])} · Phala ${formatNumber(claims.count[1])}`
                }
                secondary={claims?.through}
              />
              <MetricCard
                label="PHA claimed"
                value={
                  view &&
                  (claims
                    ? formatNumber(claims.amount[0] + claims.amount[1])
                    : '–')
                }
                primary={
                  claims &&
                  `Khala ${formatCompact(claims.amount[0])} · Phala ${formatCompact(claims.amount[1])}`
                }
                secondary={claims?.through}
              />
            </div>
          </Section>

          <Section id="cloud" title="Phala Cloud">
            <div className={CARDS}>
              <MetricCard
                label="Users"
                value={view?.cloud.users.value}
                secondary={view?.cloud.users.asOf}
              />
              <MetricCard
                label="VMs"
                value={view?.cloud.totalVms.value}
                action={
                  view?.cloud.runningVms.asOf && (
                    <Badge variant="outline">
                      {view.cloud.runningVms.value} running
                    </Badge>
                  )
                }
                secondary={view?.cloud.totalVms.asOf}
              />
              <MetricCard
                label="Total vCPU"
                value={view?.cloud.vcpu.value}
                secondary={view?.cloud.vcpu.asOf}
              />
              <MetricCard
                label="Annual revenue in PHA"
                value={view?.cloud.captured.value}
                secondary={view?.cloud.captured.asOf}
              />
            </div>
            <div className={CHARTS}>
              <ChartCard
                title="Users"
                description="Daily total"
                rows={view?.rows.cloud}
                series={USERS}
              />
              <ChartCard
                title="VMs"
                description="Total and running, daily"
                rows={view?.rows.cloud}
                series={VMS}
              />
              <ChartCard
                title="Total vCPUs"
                description="Daily total"
                rows={view?.rows.cloud}
                series={VCPU}
              />
              <ChartCard
                title="Annual revenue in PHA"
                description="Total vCPUs × 12 × $50, converted at that day's PHA price"
                rows={view?.rows.cloud}
                series={REVENUE}
              />
            </div>
          </Section>

          <footer className="px-4 lg:px-6">
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Data</h2>
                </CardTitle>
                <CardDescription>
                  {view ? `Updated ${view.updated}.` : 'Loading data…'} Daily
                  values are UTC days. Sources: the Phala Ethereum subgraph, the
                  archived Phala and Khala chain history, Phala Cloud usage
                  statistics, and daily PHA prices from Dune through September
                  22, 2026 and DefiLlama (CoinGecko-sourced) after. Data
                  refreshes hourly.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button variant="outline" size="sm" asChild>
                  <a href="/api/data">
                    <DownloadIcon data-icon="inline-start" />
                    Download the data (JSON)
                  </a>
                </Button>
              </CardFooter>
            </Card>
          </footer>
        </div>
      </main>
    </>
  )
}
