import {useCallback, useEffect, useState} from 'react'
import type {AnalyticsData} from '../../worker/data'

export type AnalyticsState =
  | {status: 'loading'}
  | {status: 'error'}
  | {status: 'ready'; data: AnalyticsData}

/** Fetches /api/data; `retry` reloads after an error. */
export function useAnalytics() {
  const [state, setState] = useState<AnalyticsState>({status: 'loading'})
  const loading = state.status === 'loading'

  useEffect(() => {
    if (!loading) return
    const controller = new AbortController()
    fetch('/api/data', {
      headers: {Accept: 'application/json'},
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: AnalyticsData = await response.json()
        setState({status: 'ready', data})
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        console.error('Failed to load analytics data', error)
        setState({status: 'error'})
      })
    return () => controller.abort()
  }, [loading])

  const retry = useCallback(() => setState({status: 'loading'}), [])
  return {state, retry}
}
