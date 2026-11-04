import {useCallback, useEffect, useState} from 'react'
import {legacyRows} from '@/lib/legacy-cpu-tee'
import type {Row} from '@/lib/series'

export type LegacyCpuTeeState =
  | {status: 'loading'}
  | {status: 'error'}
  | {status: 'ready'; rows: Row[]}

/**
 * Loads the frozen CPU (TEE) history, a separate static chunk, once `enabled`;
 * `retry` reloads after an error.
 */
export function useLegacyCpuTee(enabled: boolean) {
  const [state, setState] = useState<LegacyCpuTeeState>({status: 'loading'})
  const loading = state.status === 'loading'

  useEffect(() => {
    if (!enabled || !loading) return
    let active = true
    import('@/generated/legacy-cpu-tee.json')
      .then(({default: data}) => {
        if (active) setState({status: 'ready', rows: legacyRows(data)})
      })
      .catch((error: unknown) => {
        if (!active) return
        console.error('Failed to load legacy CPU (TEE) data', error)
        setState({status: 'error'})
      })
    return () => {
      active = false
    }
  }, [enabled, loading])

  const retry = useCallback(() => setState({status: 'loading'}), [])
  return {state, retry}
}
