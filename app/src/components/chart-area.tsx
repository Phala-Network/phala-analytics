import {useId} from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {formatCompact, formatDay, formatMonth, formatNumber} from '@/lib/format'
import {cellValue, type Row, type Series} from '@/lib/series'

/** Text alternative: the range and the latest value of each series. */
const summary = (title: string, rows: Row[], series: Series[]) => {
  const first = rows[0]
  const last = rows.at(-1)
  if (!first || !last) return `${title}: no data yet.`
  const latest = series
    .map(({key, label}) => {
      const row = rows.findLast((item) => cellValue(item, key) != null)
      return row ? `${label} ${formatNumber(cellValue(row, key))}` : null
    })
    .filter(Boolean)
    .join(', ')
  return `${title} chart from ${formatDay(first.date)} to ${formatDay(last.date)}. Latest: ${latest}.`
}

/**
 * Area chart from the shadcn/ui chart examples (chart-area-interactive,
 * chart-area-stacked, chart-area-axes, chart-area-legend). Loaded lazily, so
 * Recharts does not delay the figures.
 */
export default function ChartArea({
  title,
  rows,
  series,
  shaded = [],
}: {
  title: string
  rows: Row[]
  /** Drawn series; colors are theme variables such as `var(--chart-1)`. */
  series: (Series & {color: string})[]
  /** Inclusive [first, last] UTC days to shade. */
  shaded?: [string, string][]
}) {
  const id = useId().replaceAll(':', '')
  const chartConfig = Object.fromEntries(
    series.map(({key, label}) => [key, {label}]),
  ) satisfies ChartConfig
  // ChartConfig colors are injected as a <style> element, which the CSP
  // blocks; the same --color-* variables are set on the container instead.
  const colors = Object.fromEntries(
    series.map(({key, color}) => [`--color-${key}`, color]),
  )
  // Stacks need numbers; whole PHA keep tooltips readable.
  const chartData = rows.map((row) => ({
    date: row.date,
    ...Object.fromEntries(
      series.map(({key, stack}) => {
        const value = cellValue(row, key)
        return [key, value == null ? (stack ? 0 : null) : Math.round(value)]
      }),
    ),
  }))

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[250px] w-full"
      style={colors}
      role="img"
      aria-label={summary(title, rows, series)}
    >
      <AreaChart data={chartData} accessibilityLayer={false}>
        <defs>
          {series.map(({key}) => (
            <linearGradient
              key={key}
              id={`${id}-${key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor={`var(--color-${key})`}
                stopOpacity={0.8}
              />
              <stop
                offset="95%"
                stopColor={`var(--color-${key})`}
                stopOpacity={0.1}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} />
        {shaded.map(([x1, x2]) => (
          <ReferenceArea
            key={x1}
            x1={x1}
            x2={x2}
            fill="var(--muted-foreground)"
            fillOpacity={0.15}
          />
        ))}
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={formatMonth}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickCount={4}
          width={48}
          tickFormatter={formatCompact}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(value) =>
                typeof value === 'string' ? formatDay(value) : value
              }
              indicator="dot"
            />
          }
        />
        {series.map(({key, stack}) => (
          <Area
            key={key}
            dataKey={key}
            type="linear"
            fill={`url(#${id}-${key})`}
            stroke={`var(--color-${key})`}
            stackId={stack ? 'a' : undefined}
            isAnimationActive={false}
          />
        ))}
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      </AreaChart>
    </ChartContainer>
  )
}
