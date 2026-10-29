import type {ReactNode} from 'react'
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {Skeleton} from '@/components/ui/skeleton'
import {cn} from '@/lib/utils'

/** Section card from the dashboard-01 block (section-cards). */
export function MetricCard({
  label,
  value,
  action,
  primary,
  secondary,
  className,
}: {
  label: string
  /** Undefined while loading. */
  value: string | undefined
  action?: ReactNode
  primary?: ReactNode
  secondary?: ReactNode
  className?: string
}) {
  return (
    <Card className={cn('@container/card', className)}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {value ?? <Skeleton className="h-8 w-32" />}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1.5 text-sm">
        {value === undefined ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <>
            {primary && (
              <div className="line-clamp-1 flex gap-2 font-medium">
                {primary}
              </div>
            )}
            <div className="text-muted-foreground">{secondary}</div>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
