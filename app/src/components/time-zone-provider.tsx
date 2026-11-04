import * as React from 'react'
import {isTimeZone, type TimeZone} from '@/lib/format'

type TimeZoneProviderProps = {
  children: React.ReactNode
  defaultTimeZone?: TimeZone
  storageKey?: string
}

type TimeZoneProviderState = {
  timeZone: TimeZone
  setTimeZone: (timeZone: TimeZone) => void
}

const TimeZoneProviderContext = React.createContext<
  TimeZoneProviderState | undefined
>(undefined)

/** The time zone for exact timestamps, persisted like the theme. */
export function TimeZoneProvider({
  children,
  defaultTimeZone = 'local',
  storageKey = 'time-zone',
}: TimeZoneProviderProps) {
  const [timeZone, setTimeZoneState] = React.useState<TimeZone>(() => {
    const storedTimeZone = localStorage.getItem(storageKey)
    return isTimeZone(storedTimeZone) ? storedTimeZone : defaultTimeZone
  })

  const setTimeZone = React.useCallback(
    (nextTimeZone: TimeZone) => {
      localStorage.setItem(storageKey, nextTimeZone)
      setTimeZoneState(nextTimeZone)
    },
    [storageKey],
  )

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== storageKey) {
        return
      }
      setTimeZoneState(
        isTimeZone(event.newValue) ? event.newValue : defaultTimeZone,
      )
    }

    window.addEventListener('storage', handleStorageChange)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
    }
  }, [defaultTimeZone, storageKey])

  const value = React.useMemo(
    () => ({timeZone, setTimeZone}),
    [timeZone, setTimeZone],
  )

  return (
    <TimeZoneProviderContext.Provider value={value}>
      {children}
    </TimeZoneProviderContext.Provider>
  )
}

export const useTimeZone = () => {
  const context = React.useContext(TimeZoneProviderContext)

  if (context === undefined) {
    throw new Error('useTimeZone must be used within a TimeZoneProvider')
  }

  return context
}
