/**
 * dsh-user-balance — Host half.
 *
 * Reads the DeepSeek account balance and answers one RPC endpoint. This half is
 * the only place the API key exists: the key is resolved through the credentials
 * service, used as a request header, and never returned, logged, or copied into
 * a result. The browser receives amounts only.
 *
 * The plugin registers no tool and no prompt section, so no model turn can
 * observe the key or the balance.
 *
 * This half imports nothing. A profile installs the plugin outside the Harness
 * package tree, so a bare `@deepseek-ai/*` import would not resolve and the
 * loader row would fail the whole profile. Every seam is read from the context
 * object instead.
 */

export const name = 'user-balance'

/** Required services. `credentials` must be composed for the plugin to activate. */
export const inject = ['credentials']

/** Endpoint name shared with the Client half. */
export const RPC_ENDPOINT = 'user-balance'

/** Official balance endpoint. A self-hosted deployment overrides it per call. */
export const DEFAULT_API_BASE = 'https://api.deepseek.com'

/** Credential reference names tried in order. The provider uses the first one. */
export const API_KEY_REFS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_TOKEN']

/** A cached reading is fresh for this long. */
export const FRESH_MS = 60_000
/** A cached reading older than this is not served again. */
const STALE_MS = 10 * 60_000
/** One balance request is abandoned after this long. */
const REQUEST_TIMEOUT_MS = 15_000

/** Credential references match a POSIX shell identifier. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read the API key without exposing it.
 *
 * Precedence matches the model provider: the credentials service first, then
 * the launch environment. An empty value counts as absent. The credentials
 * service layers the environment and `.env` files itself, so the direct
 * environment read is only a fallback for a profile without that service.
 *
 * @param ctx - the Cordis plugin context.
 * @returns the key and a redactor for diagnostic text, or undefined.
 */
async function readApiKey(ctx) {
  const credentials = ctx.get('credentials')
  for (const name of API_KEY_REFS) {
    if (!REF_PATTERN.test(name)) continue
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      // A branded reference is a plain string at runtime, so no import is needed.
      const hit = await credentials.resolve(name)
      if (hit?.value) return { name, value: hit.value, redact: redactor(hit.value) }
    }
    const ambient = ambientValue(ctx, name)
    if (ambient) return { name, value: ambient, redact: redactor(ambient) }
  }
  return undefined
}

/**
 * Read one variable from the launch environment, falling back to the process
 * environment when the launcher contributed no snapshot.
 *
 * @param ctx - the Cordis plugin context.
 * @param name - the variable name.
 * @returns the value, or undefined when unset or empty.
 */
function ambientValue(ctx, name) {
  let environment
  try {
    environment = ctx.get('launchEnvironment')
  } catch {
    environment = undefined
  }
  if (environment !== undefined && typeof environment.get === 'function') {
    const hit = environment.get(name)
    if (hit?.value) return hit.value
  }
  const direct = process.env[name]
  return direct === undefined || direct === '' ? undefined : direct
}

/**
 * Build a scrubber for diagnostic text.
 *
 * A network error quotes the request, so its own message can carry the key.
 * Every string that leaves this half passes through the returning function.
 *
 * @param secret - the API key.
 * @returns a function that removes the key from one string.
 */
function redactor(secret) {
  return (text) => String(text).split(secret).join('<redacted>')
}

/** Reject a value that is not an absolute HTTP(S) origin. */
function normalizeApiBase(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_API_BASE
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new QueryError('user-balance/bad-api-base', `API base is not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new QueryError('user-balance/bad-api-base', `API base must be http or https: ${raw}`)
  }
  return url.origin
}

/** One failure with a stable code, for the Client half to translate. */
export class QueryError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - diagnostic text. It never carries the API key.
   * @param details - extra fields for the Client half.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Keep one money field a decimal string; a missing field becomes null. */
function money(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return String(value)
  return value.trim() === '' ? null : value
}

/**
 * Validate and reduce one `balance_infos` entry.
 *
 * @param raw - one entry of the API response.
 * @returns the public shape, or null when the entry is unusable.
 */
function wallet(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : ''
  if (currency === '') return null
  return {
    currency,
    totalBalance: money(raw.total_balance),
    grantedBalance: money(raw.granted_balance),
    toppedUpBalance: money(raw.topped_up_balance),
  }
}

/**
 * Fetch and validate one reading.
 *
 * @param options - resolved request facts.
 * @returns the public reading.
 */
async function fetchBalance({ apiBase, apiKey, redact, signal }) {
  let response
  try {
    response = await fetch(`${apiBase}/user/balance`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal,
    })
  } catch (error) {
    // The transport's own message quotes the request, so it is scrubbed before
    // it can reach a log line or an RPC result.
    throw new QueryError('user-balance/request-failed', redact(describe(error)), {
      cause: error instanceof Error ? error.name : typeof error,
    })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new QueryError(
      'user-balance/http-error',
      `Balance request failed with HTTP ${String(response.status)}`,
      { status: response.status },
    )
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new QueryError('user-balance/bad-response', 'Balance response is not JSON')
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.balance_infos)) {
    throw new QueryError('user-balance/bad-response', 'Balance response has no balance_infos array')
  }
  const wallets = body.balance_infos.map(wallet).filter((entry) => entry !== null)
  if (wallets.length === 0) {
    throw new QueryError('user-balance/bad-response', 'Balance response carries no usable wallet')
  }
  return { isAvailable: body.is_available === true, wallets }
}

/** Write one warning line that cannot carry the API key. */
function warn(logger, text) {
  try {
    logger.warn?.(`[user-balance] ${text}`)
  } catch {
    // A logger that fails must not fail the query.
  }
}

/**
 * Build the balance reader with its own cache.
 *
 * @param ctx - the Cordis plugin context.
 * @returns the query entry point.
 */
function createReader(ctx) {
  const logger = ctx.logger ?? console
  let cached
  let inFlight

  /** Read the cache, or ask the network. One network request runs at a time. */
  const load = async (options, signal) => {
    const now = Date.now()
    if (!options.refresh && cached !== undefined && now - cached.at < FRESH_MS) {
      return { reading: cached.reading, stale: false }
    }
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const reading = await fetchBalance({ ...options, signal })
        cached = { at: Date.now(), reading }
        return { reading, stale: false }
      } catch (error) {
        // A cached reading stays usable for a while, so a network blip does not
        // blank the chip.
        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
          warn(logger, `query failed; serving a cached reading: ${options.redact(describe(error))}`)
          return { reading: cached.reading, stale: true }
        }
        throw error
      }
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
    }
  }

  return async (payload, signal) => {
    const request = payload !== null && typeof payload === 'object' ? payload : {}
    const key = await readApiKey(ctx)
    if (key === undefined) {
      return {
        ok: true,
        value: {
          configured: false,
          refsTried: API_KEY_REFS,
          error: {
            code: 'user-balance/not-configured',
            message: `No API key found. Tried: ${API_KEY_REFS.join(', ')}.`,
            details: {},
          },
        },
      }
    }
    try {
      const apiBase = normalizeApiBase(request.apiBase)
      // One deadline per query, combined with the caller's cancellation.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const { reading, stale } = await load(
        { apiBase, apiKey: key.value, redact: key.redact, refresh: request.refresh === true },
        deadline,
      )
      return { ok: true, value: { configured: true, ...reading, fetchedAt: Date.now(), stale } }
    } catch (error) {
      warn(logger, `query failed: ${key.redact(describe(error))}`)
      return {
        ok: true,
        value: {
          configured: true,
          error: {
            code: error instanceof QueryError ? error.code : 'user-balance/request-failed',
            message: key.redact(describe(error)),
            details: error instanceof QueryError ? error.details : {},
          },
        },
      }
    }
  }
}

/** One diagnostic line. The API key never enters this text. */
function describe(error) {
  if (error instanceof QueryError) return error.message
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** Exact Fetch route this plugin owns. The browser calls it as `/api/user-balance`. */
export const RPC_PATH = '/api/user-balance'

/**
 * Activate the plugin.
 *
 * The route is registered through `connection.fetch`, which is the per-plugin
 * seam: the shared-channel interceptor accepts one owner per process and is
 * therefore already taken on a composed web profile. A Fetch route carries its
 * own JSON envelope, so this half answers the same `client-request` /
 * `server-response` pair the Client half sends.
 *
 * The registration is not wrapped in an effect of this plugin. An injected
 * scope is disposed, and a registration that hangs off it dies with it.
 *
 * @param ctx - the Cordis plugin context.
 */
export function apply(ctx) {
  const query = createReader(ctx)
  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection ?? scope.get('connection')
    if (connection?.fetch === undefined || typeof connection.fetch.register !== 'function') {
      ctx.logger?.warn?.('[user-balance] connection.fetch unavailable; the balance chip stays empty')
      return
    }
    connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
        let message
        try {
          message = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = message?.payload
        if (
          message?.type !== 'client-request' ||
          typeof message.rpcId !== 'string' ||
          message.method !== RPC_ENDPOINT ||
          call === null ||
          typeof call !== 'object' ||
          (call.method !== undefined && call.method !== 'query')
        ) {
          return reply(rpcId, {
            ok: false,
            error: { code: 'user-balance/bad-request', message: 'Invalid balance request.', details: {} },
          })
        }
        try {
          return reply(rpcId, await query(call, request.signal))
        } catch (error) {
          ctx.logger?.warn?.(`[user-balance] handler failed: ${String(error)}`)
          return reply(rpcId, {
            ok: false,
            error: { code: 'user-balance/handler-failed', message: 'Balance handler failed.', details: {} },
          })
        }
      },
    })
  })
}

/**
 * Build the JSON-RPC reply envelope the browser client understands.
 *
 * @param rpcId - the correlation id echoed from the request.
 * @param result - the `{ ok, value }` or `{ ok: false, error }` payload.
 * @returns an HTTP response carrying the envelope.
 */
function reply(rpcId, result) {
  const value =
    typeof result === 'object' && result !== null && result.ok === false
      ? { ...result, error: { ...result.error, details: result.error?.details ?? {} } }
      : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
