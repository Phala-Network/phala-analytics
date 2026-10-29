import {ChevronsUpDownIcon} from 'lucide-react'
import {lazy, type ReactNode, Suspense} from 'react'
import {Button} from '@/components/ui/button'
import {
  Card,
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
import {ScrollArea} from '@/components/ui/scroll-area'
import {Skeleton} from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
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
 * series unless `table` gives others. The footer follows the block's
 * section-cards footer.
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
  footer?: ReactNode
}) {
  const drawn = series.flatMap((item) =>
    item.color ? [{...item, color: item.color}] : [],
  )
  const tableRows = table ? table.rows : rows
  const tableSeries = table ? table.series : series
  const isShaded = (date: string) =>
    shaded.some(([first, last]) => first <= date && date <= last)
  const skeleton = <Skeleton className="h-[250px] w-full" />

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <Suspense fallback={skeleton}>
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
            />
          ) : (
            skeleton
          )}
        </Suspense>
      </CardContent>
      <CardFooter className="flex-col items-start gap-1.5 text-sm">
        <Collapsible className="w-full">
          <CollapsibleTrigger asChild disabled={!tableRows}>
            <Button
              variant="link"
              className="w-fit px-0 text-left text-foreground"
            >
              <ChevronsUpDownIcon />
              Data table
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {tableRows && (
              <ScrollArea className="h-72 rounded-md border">
                <Table>
                  <TableCaption>{title} data, newest first.</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date (UTC)</TableHead>
                      {tableSeries.map(({key, label}) => (
                        <TableHead key={key} className="text-right">
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tableRows.toReversed().map((row) => (
                      <TableRow key={row.date}>
                        <TableCell className="font-medium">
                          {formatDay(row.date)}
                          {shadedLabel && isShaded(row.date) && (
                            <span className="text-muted-foreground">
                              {` (${shadedLabel})`}
                            </span>
                          )}
                        </TableCell>
                        {tableSeries.map(({key}) => (
                          <TableCell key={key} className="text-right">
                            {formatNumber(cellValue(row, key))}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CollapsibleContent>
        </Collapsible>
        {footer && <div className="text-muted-foreground">{footer}</div>}
      </CardFooter>
    </Card>
  )
}
