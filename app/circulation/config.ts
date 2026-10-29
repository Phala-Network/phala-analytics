export interface Config {
  ethereumUrl: string
  timeoutMs: number
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export const readConfig = (env: {
  GOLDSKY_ETHEREUM_URL?: string
  UPSTREAM_TIMEOUT_MS?: string
}): Config => {
  const optional = (name: keyof typeof env) => env[name] || undefined
  const required = (name: keyof typeof env) => {
    const value = optional(name)
    if (!value) throw new ConfigError(`${name} is not set`)
    return value
  }
  const positiveInt = (name: keyof typeof env, fallback: number) => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive integer`)
    }
    return value
  }
  return {
    ethereumUrl: required('GOLDSKY_ETHEREUM_URL'),
    timeoutMs: positiveInt('UPSTREAM_TIMEOUT_MS', 8000),
  }
}
