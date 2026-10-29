import {
  DownloadIcon,
  InfoIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import {type ReactNode, useMemo} from 'react'
import {ChartAreaCard} from '@/components/chart-area-card'
import {MetricCard} from '@/components/metric-card'
import {PhalaLogo} from '@/components/phala-logo'
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Separator} from '@/components/ui/separator'
import {useAnalytics} from '@/hooks/use-analytics'
import {
  formatCompact,
  formatDay,
  formatDayRange,
  formatNumber,
  formatPercent,
  formatTimestamp,
} from '@/lib/format'
import {
  backfillRanges,
  dailyRewards,
  latest,
  type Row,
  type Series,
  toRows,
} from '@/lib/series'
import type {AnalyticsData} from '../worker/data'

// Single series use the primary color, as in dashboard-01; multiple series use
// the theme's chart colors.
const CIRCULATION: Series[] = [
  {key: 'ethereum', label: 'Ethereum', color: 'var(--chart-2)', stack: true},
  {key: 'phala', label: 'Phala', color: 'var(--chart-4)', stack: true},
  {key: 'khala', label: 'Khala', color: 'var(--chart-1)', stack: true},
  {key: 'total', label: 'Total'},
]
const VAULT: Series[] = [
  {key: 'totalAssets', label: 'Total assets', color: 'var(--primary)'},
]
const REWARDS: Series[] = [
  {key: 'average', label: '7-day average', color: 'var(--primary)'},
  {key: 'dailyRewards', label: 'Daily'},
]
const USERS: Series[] = [
  {key: 'totalUsers', label: 'Users', color: 'var(--primary)'},
]
const VMS: Series[] = [
  {key: 'totalVms', label: 'Total VMs', color: 'var(--chart-2)'},
  {key: 'runningVms', label: 'Running VMs', color: 'var(--chart-4)'},
]
const VCPU: Series[] = [
  {key: 'totalVcpu', label: 'Total vCPUs', color: 'var(--primary)'},
]
const REVENUE: Series[] = [
  {key: 'captured', label: 'Annual revenue', color: 'var(--primary)'},
]

const LINKS = [
  {href: 'https://phala.com', label: 'Website'},
  {href: 'https://phala.com/x', label: 'X'},
  {href: 'https://phala.com/discord', label: 'Discord'},
]

// Section-cards grid from dashboard-01; column counts follow the card count.
const CARDS =
  'grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs dark:*:data-[slot=card]:bg-card'

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
    shaded: backfillRanges(data.cloud),
    rows: {
      circulation: toRows(
        data.circulation,
        ({ethereum, phala, khala, total}) => ({ethereum, phala, khala, total}),
      ),
      vault: toRows(data.vault, ({totalAssets}) => ({totalAssets})),
      rewards: dailyRewards(data.vault),
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
    <section aria-labelledby={id} className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-xl font-semibold">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

const ExternalLink = ({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) => (
  <a
    href={href}
    className="font-medium text-foreground underline underline-offset-4"
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
    <div className="flex min-h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <PhalaLogo className="h-6 w-auto" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <h1 className="text-base font-medium">
            <span className="sr-only">Phala </span>Analytics
          </h1>
          <nav
            aria-label="Phala links"
            className="ml-auto flex items-center gap-1"
          >
            {LINKS.map(({href, label}) => (
              <Button key={href} variant="ghost" size="sm" asChild>
                <a href={href}>{label}</a>
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <main
        className="@container/main mx-auto flex w-full max-w-7xl flex-1 flex-col gap-2"
        aria-busy={state.status === 'loading'}
      >
        <div className="flex flex-col gap-8 py-4 md:gap-10 md:py-6">
          <div className="flex flex-col gap-3 px-4 lg:px-6">
            <p className="max-w-3xl text-muted-foreground">
              Phala: The New Cloud for Confidential AI. Hardware-secured compute
              platform that delivers verifiable AI with enterprise-grade
              privacy. Deploy confidential AI models with TEE protection in
              minutes.
            </p>
            <div
              role="status"
              className="flex min-h-8 items-center gap-2 text-sm"
            >
              {state.status === 'error' ? (
                <Alert variant="destructive" className="max-w-md">
                  <TriangleAlertIcon />
                  <AlertTitle>
                    Analytics data is temporarily unavailable.
                  </AlertTitle>
                  <AlertDescription>
                    <Button variant="outline" size="sm" onClick={retry}>
                      <RotateCwIcon />
                      Retry
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <Badge variant="outline">
                  {view ? `Updated ${view.updated}` : 'Loading data…'}
                </Badge>
              )}
            </div>
          </div>

          <Section
            id="token"
            title="$PHA Token"
            description={
              <ExternalLink href="https://coinmarketcap.com/currencies/phala-network/">
                CoinMarketCap
              </ExternalLink>
            }
          >
            <ChartAreaCard
              title="Circulating supply"
              description="By chain at 00:00 UTC each day, stacked (PHA)"
              rows={view?.rows.circulation}
              series={CIRCULATION}
              headline={
                <div className="flex flex-col gap-1 pt-2">
                  <div className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                    {view ? (
                      `${view.circulation} PHA`
                    ) : (
                      <span className="inline-block h-8" />
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {view ? `Now, as of ${view.circulationAsOf}` : ' '}
                  </div>
                </div>
              }
              footer="Ethereum plus the Phala and Khala chains until their sunset. Base PHA is counted through the Ethereum Portal escrow."
            />
          </Section>

          <Section
            id="vault"
            title="$PHA Vault"
            description={
              <>
                Stake $PHA on Ethereum to get rewards:{' '}
                <ExternalLink href="https://app.phala.network/staking">
                  app.phala.network/staking
                </ExternalLink>
              </>
            }
          >
            {view && !view.vault.reviewed && (
              <Alert role="note">
                <InfoIcon />
                <AlertTitle>Vault upgrade under review</AlertTitle>
                <AlertDescription>
                  The Vault runs an implementation that has not been reviewed
                  yet. Its figures are shown as indexed, and APR is hidden until
                  the review is complete.
                </AlertDescription>
              </Alert>
            )}
            <div
              className={`${CARDS} @xl/main:grid-cols-2 @3xl/main:grid-cols-3`}
            >
              <MetricCard
                className="@xl/main:col-span-2 @3xl/main:col-span-1"
                label="Total assets"
                value={view && `${view.vault.totalAssets} PHA`}
                secondary={view?.vault.vaultAsOf}
              />
              <MetricCard
                label="APR"
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
                label="Stakers"
                value={view?.vault.stakers}
                secondary={view?.vault.vaultAsOf}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 @5xl/main:grid-cols-2">
              <ChartAreaCard
                title="Total assets"
                description="At 00:00 UTC each day (PHA)"
                rows={view?.rows.vault}
                series={VAULT}
              />
              <ChartAreaCard
                title="Daily rewards"
                description="Trailing 7-day average of rewards accrued each UTC day (PHA)"
                rows={view?.rows.rewards}
                series={REWARDS}
                footer="The data table lists each day's rewards."
              />
            </div>
          </Section>

          <Section
            id="claims"
            title="Sunset claims"
            description="PHA claimed on Ethereum by former Khala and Phala chain holders"
          >
            <div className={`${CARDS} @xl/main:grid-cols-2`}>
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
                    ? `${formatNumber(claims.amount[0] + claims.amount[1])} PHA`
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
            <div
              className={`${CARDS} @xl/main:grid-cols-2 @3xl/main:grid-cols-3 @5xl/main:grid-cols-5`}
            >
              <MetricCard
                label="Users"
                value={view?.cloud.users.value}
                secondary={view?.cloud.users.asOf}
              />
              <MetricCard
                label="Total VMs"
                value={view?.cloud.totalVms.value}
                secondary={view?.cloud.totalVms.asOf}
              />
              <MetricCard
                label="Running VMs"
                value={view?.cloud.runningVms.value}
                secondary={view?.cloud.runningVms.asOf}
              />
              <MetricCard
                label="Total vCPU"
                value={view?.cloud.vcpu.value}
                secondary={view?.cloud.vcpu.asOf}
              />
              <MetricCard
                className="@xl/main:col-span-2 @5xl/main:col-span-1"
                label="Annual revenue in PHA"
                value={view && `${view.cloud.captured.value} PHA`}
                secondary={view?.cloud.captured.asOf}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 @5xl/main:grid-cols-2">
              <ChartAreaCard
                title="Users"
                description="Daily total"
                rows={view?.rows.cloud}
                series={USERS}
                shaded={view?.shaded}
                shadedLabel="recomputed"
              />
              <ChartAreaCard
                title="VMs"
                description="Total and running, daily"
                rows={view?.rows.cloud}
                series={VMS}
                shaded={view?.shaded}
                shadedLabel="recomputed"
              />
              <ChartAreaCard
                title="Total vCPUs"
                description="Daily total"
                rows={view?.rows.cloud}
                series={VCPU}
              />
              <ChartAreaCard
                title="Annual revenue in PHA"
                description="Total vCPUs × 12 × $50, converted at that day's PHA price"
                rows={view?.rows.cloud}
                series={REVENUE}
              />
            </div>
            {view && view.shaded.length > 0 && (
              <Alert role="note">
                <InfoIcon />
                <AlertTitle>Backfilled days are shaded</AlertTitle>
                <AlertDescription>
                  {view.shaded.map(formatDayRange).join(', ')}: Phala Cloud
                  recomputes past days using each VM's and user's current
                  status, so running VMs and users are understated for those
                  days.
                </AlertDescription>
              </Alert>
            )}
          </Section>
        </div>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground lg:px-6">
          <p className="max-w-3xl">
            Daily values are UTC days. Sources: the Phala Ethereum subgraph, the
            archived Phala and Khala chain history, Phala Cloud usage
            statistics, and daily PHA prices from Dune through September 22,
            2026 and DefiLlama (CoinGecko-sourced) after. Data refreshes hourly.
          </p>
          <div>
            <Button variant="outline" size="sm" asChild>
              <a href="/api/data">
                <DownloadIcon />
                Download the data (JSON)
              </a>
            </Button>
          </div>
        </div>
      </footer>
    </div>
  )
}
