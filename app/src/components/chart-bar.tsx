import {Bar, BarChart, CartesianGrid, XAxis, YAxis} from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {formatCompact, formatDay, formatMonth} from '@/lib/format'
import {cellValue, type Row, type Series} from '@/lib/series'
import {summary} from './chart-area'

/**
 * Bar chart from the shadcn/ui chart examples (chart-bar-interactive) with the
 * axis from chart-area-axes, legend from chart-bar-multiple and stacking from
 * chart-bar-stacked. Each row is one period labelled by its first day.
 */
export default function ChartBar({
  title,
  rows,
  series,
  periodLabel,
}: {
  title: string
  rows: Row[]
  /** Drawn series; colors are theme variables such as `var(--chart-2)`. */
  series: (Series & {color: string})[]
  /** Tooltip label prefix for a period's first day, e.g. "Week of". */
  periodLabel?: string
}) {
  const chartConfig = Object.fromEntries(
    series.map(({key, label}) => [key, {label}]),
  ) satisfies ChartConfig
  // ChartConfig colors would be injected as a <style> element, which the CSP
  // blocks; the --color-* variables are set on the container instead.
  const colors = Object.fromEntries(
    series.map(({key, color}) => [`--color-${key}`, color]),
  )
  const chartData = rows.map((row) => ({
    date: row.date,
    ...Object.fromEntries(
      series.map(({key}) => [key, Math.round(cellValue(row, key) ?? 0)]),
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
      <BarChart data={chartData} accessibilityLayer={false}>
        <CartesianGrid vertical={false} />
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
          content={
            <ChartTooltipContent
              labelFormatter={(value) =>
                typeof value !== 'string'
                  ? value
                  : periodLabel
                    ? `${periodLabel} ${formatDay(value)}`
                    : formatDay(value)
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map(({key, stack}) => (
          <Bar
            key={key}
            dataKey={key}
            fill={`var(--color-${key})`}
            stackId={stack ? 'a' : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}
