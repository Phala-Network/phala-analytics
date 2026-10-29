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
 * axis from chart-area-axes and the legend from chart-bar-multiple. Each row is one period labelled by its first day.
 */
export default function ChartBar({
  title,
  rows,
  series,
  periodLabel,
}: {
  title: string
  rows: Row[]
  /** One drawn series; its color is a theme variable such as `var(--chart-2)`. */
  series: Series & {color: string}
  /** Tooltip label prefix for a period's first day, e.g. "Week of". */
  periodLabel: string
}) {
  const {key, label, color} = series
  const chartConfig = {[key]: {label}} satisfies ChartConfig
  // ChartConfig colors would be injected as a <style> element, which the CSP
  // blocks; the --color-* variable is set on the container instead.
  const chartData = rows.map((row) => ({
    date: row.date,
    [key]: Math.round(cellValue(row, key) ?? 0),
  }))

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[250px] w-full"
      style={{[`--color-${key}`]: color}}
      role="img"
      aria-label={summary(title, rows, [series])}
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
                typeof value === 'string'
                  ? `${periodLabel} ${formatDay(value)}`
                  : value
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey={key}
          fill={`var(--color-${key})`}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
