import {ChevronDownIcon} from 'lucide-react'
import {lazy, type ReactNode, Suspense} from 'react'
import {Button} from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {Skeleton} from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {formatDay, formatNumber} from '@/lib/format'
import {cellValue, type Row, type Series} from '@/lib/series'

const ChartArea = lazy(() => import('./chart-area'))
const ChartBar = lazy(() => import('./chart-bar'))

/**
 * Chart card from the dashboard-01 block (chart-area-interactive) with a
 * collapsible data table, newest first. The table lists the chart's rows and
 * series unless `table` gives others.
 */
export function ChartCard({
  title,
  description,
  rows,
  series,
  shaded = [],
  shadedLabel,
  bars,
  table,
  headline,
  action,
  footer,
}: {
  title: string
  description: string
  /** Undefined while loading. */
  rows: Row[] | undefined
  /** Series with a color are drawn; the others appear in the table only. */
  series: Series[]
  shaded?: [string, string][]
  /** Table marker for rows inside `shaded`. */
  shadedLabel?: string
  /** Draw the first colored series as bars; the tooltip prefixes each row's date. */
  bars?: {periodLabel: string}
  table?: {rows: Row[] | undefined; series: Series[]}
  headline?: ReactNode
  action?: ReactNode
  footer?: ReactNode
}) {
  const drawn = series.flatMap((item) =>
    item.color ? [{...item, color: item.color}] : [],
  )
  const tableRows = table ? table.rows : rows
  const tableSeries = table ? table.series : series
  // A legend (pt-3 and one text-xs line) takes 28px from the chart, so
  // charts with one are taller and every plot is 250px.
  const height = !bars && drawn.length > 1 ? 'h-[278px]' : 'h-[250px]'
  const isShaded = (date: string) =>
    shaded.some(([first, last]) => first <= date && date <= last)

  return (
    // Subgrid rows line up the header, chart and footer of cards in a row; a
    // container query on the card would disable the subgrid.
    <Card className="row-span-3 grid grid-rows-subgrid">
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        {action && <CardAction>{action}</CardAction>}
        {headline}
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <Suspense fallback={<Skeleton className={`${height} w-full`} />}>
          {rows && bars && drawn[0] ? (
            <ChartBar
              title={title}
              rows={rows}
              series={drawn[0]}
              periodLabel={bars.periodLabel}
            />
          ) : rows ? (
            <ChartArea
              title={title}
              rows={rows}
              series={drawn}
              shaded={shaded}
              className={height}
            />
          ) : (
            <Skeleton className={`${height} w-full`} />
          )}
        </Suspense>
      </CardContent>
      {/* The table trigger leads the footer, so triggers line up across a row. */}
      <CardFooter className="flex-col items-start gap-2 text-sm">
        <Collapsible className="w-full">
          <CollapsibleTrigger asChild disabled={!tableRows}>
            <Button variant="ghost" size="sm" className="group -ml-1.5">
              <ChevronDownIcon
                data-icon="inline-start"
                className="transition-transform group-data-[state=open]:rotate-180"
              />
              Data table
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {tableRows && (
              <section
                className="max-h-80 overflow-auto"
                aria-label={`${title} data`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
                tabIndex={0}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Date (UTC)</TableHead>
                      {tableSeries.map(({key, label}) => (
                        <TableHead key={key} scope="col" className="text-right">
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tableRows.toReversed().map((row) => (
                      <TableRow key={row.date}>
                        <TableHead scope="row" className="font-normal">
                          {formatDay(row.date)}
                          {shadedLabel && isShaded(row.date) && (
                            <span className="text-muted-foreground">
                              {` (${shadedLabel})`}
                            </span>
                          )}
                        </TableHead>
                        {tableSeries.map(({key}) => (
                          <TableCell
                            key={key}
                            className="text-right tabular-nums"
                          >
                            {formatNumber(cellValue(row, key))}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            )}
          </CollapsibleContent>
        </Collapsible>
        {footer && <div className="text-muted-foreground">{footer}</div>}
      </CardFooter>
    </Card>
  )
}
