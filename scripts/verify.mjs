/**
 * Verification for dsh-user-balance.
 *
 * Runs the real Host and Client halves against stubbed seams: the credentials
 * service, the launch environment, the RPC interceptor, and a minimal React.
 * The checks that matter most are the no-leak ones: the API key must never
 * appear in a result, a log line, or the rendered tree.
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATE = '/tmp/dsh-user-balance-verify-cache'
const API_KEY = 'sk-VERIFY-SECRET-DO-NOT-LEAK'
const PROJECT = new URL('../', import.meta.url).pathname

let passed = 0
const failures = []

/** Record one check. */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail === '' ? name : `${name} — ${detail}`)
}

/**
 * Loader hooks share one module registry, so each generation needs its own
 * hook file AND its own `stub:` URLs. A reused URL would hand a later test the
 * stub instance an earlier test created. Registered paths are tracked so each
 * hook is registered once.
 */
const STUBS = new Map()
const registeredHooks = new Set()

/** Write one hook file for the current stub table. */
async function writeLoader(path, tag) {
  const names = JSON.stringify([...STUBS.keys()])
  const table = [...STUBS.entries()]
    .map(([specifier, source]) => `${JSON.stringify(specifier)}: ${JSON.stringify(source)}`)
    .join(',\n  ')
  await mkFile(
    path,
    `const NAMES = ${names}
const TAG = ${JSON.stringify(tag)}
const STUBS = {\n  ${table}\n}
export async function resolve(specifier, context, next) {
  if (NAMES.includes(specifier)) return { url: 'stub:' + TAG + '/' + encodeURIComponent(specifier), format: 'module', shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith('stub:')) {
    const source = STUBS[decodeURIComponent(url.slice(url.indexOf('/') + 1))]
    if (source === undefined) throw new Error('unstubbed module: ' + url)
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
`,
  )
}

/**
 * Import a module with stubbed `@deepseek-ai/*` imports, bypassing the module
 * cache so every test gets fresh module state.
 * @param path - absolute file path.
 * @param stubs - map of package name to module source.
 * @returns the module namespace.
 */
let generation = 0
async function importWithStubs(path, stubs) {
  generation += 1
  const tag = `gen${String(generation)}`
  for (const [specifier, source] of Object.entries(stubs)) STUBS.set(specifier, source)
  const hookPath = `${CANDIDATE}-hooks/hook-${tag}.mjs`
  await writeLoader(hookPath, tag)
  if (!registeredHooks.has(hookPath)) {
    const { register } = await import('node:module')
    register(pathToFileURL(hookPath), import.meta.url)
    registeredHooks.add(hookPath)
  }
  return import(`${pathToFileURL(path).href}?generation=${String(generation)}`)
}

/** Write one file, creating parent directories. */
async function mkFile(path, text) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await writeFile(path, text)
}

/** Build a Host context whose `credentials` service answers from `values`. */
function hostContext({ values = {}, env = {}, logger = { warn() {}, info() {} } }) {
  const connectionRoutes = []
  const ctx = {
    logger,
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            return values[ref] === undefined ? undefined : { value: values[ref], source: 'verify' }
          },
        }
      }
      if (name === 'launchEnvironment') {
        return {
          get(variable) {
            return env[variable] === undefined ? undefined : { value: env[variable], source: 'process' }
          },
        }
      }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('connection')) {
        const connection = {
          fetch: {
            register(route) {
              connectionRoutes.push(route)
            },
          },
        }
        callback({ connection, get: (name) => (name === 'connection' ? connection : undefined) })
      }
    },
  }
  return { ctx, connectionRoutes }
}

/**
 * Call the registered route the way the browser does.
 *
 * @param host - a loaded Host half.
 * @param payload - the request payload.
 * @param options - optional abort signal and request overrides.
 * @returns the decoded envelope plus the HTTP status.
 */
async function callHost(host, payload, options = {}) {
  const route = host.connectionRoutes[0]
  if (route === undefined) throw new Error('no route registered')
  // A GET/HEAD request must not carry a body.
  const bodiless = options.method === 'GET' || options.method === 'HEAD'
  const request = new Request('http://127.0.0.1/api/user-balance', {
    method: options.method ?? 'POST',
    headers: { 'content-type': options.contentType ?? 'application/json' },
    ...(bodiless
      ? {}
      : {
          body: options.rawBody ?? JSON.stringify({
            type: 'client-request',
            rpcId: 'verify-1',
            method: options.rpcMethod ?? 'user-balance',
            payload,
          }),
        }),
    signal: options.signal,
  })
  const response = await route.fetch(request)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body, result: body?.result }
}

/**
 * Load the Host half.
 *
 * The half must import nothing, so the stub table stays empty: a bare
 * `@deepseek-ai/*` import would fail here exactly as it failed in the profile.
 */
async function loadHost({ values = {}, env = {} } = {}) {
  const warnings = []
  const module = await importWithStubs(`${PROJECT}lib/index.js`, {})
  const { ctx, connectionRoutes } = hostContext({ values, env, logger: { warn: (text) => warnings.push(text), info() {} } })
  module.apply(ctx)
  return { module, connectionRoutes, warnings }
}

/** A canned healthy balance response. */
const HEALTHY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
  ],
}

/** Install a fetch stub and return the recorded calls. */
function installFetch(implementation) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return implementation(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** Build a Response-like object. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}


/* ---------------------------------------------------------------- *
 * Host half
 * ---------------------------------------------------------------- */

const hostCases = []

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const module = host.module
  check('host: plugin name', module.name === 'user-balance')
  check('host: injects credentials', Array.isArray(module.inject) && module.inject.includes('credentials'))
  check('host: registers exactly one route', host.connectionRoutes.length === 1)
  check('host: route path is under /api', host.connectionRoutes[0]?.path === '/api/user-balance')
  check('host: route accepts POST only', JSON.stringify(host.connectionRoutes[0]?.methods) === JSON.stringify(['POST']))
  check('host: route buffers its body', host.connectionRoutes[0]?.requestBody === 'buffered')
  hostCases.push(host)
}

{
  const { module } = await loadHost({})
  check('host: value exports present', typeof module.apply === 'function' && typeof module.RPC_ENDPOINT === 'string')
  check('host: default API base', module.DEFAULT_API_BASE === 'https://api.deepseek.com')
}

/* ---------------------------------------------------------------- *
 * Query behavior
 * ---------------------------------------------------------------- */

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  const result = (await callHost(host, { method: 'query' })).result
  fetchCalls.restore()

  check('query: succeeds', result.ok === true)
  check('query: reports configured', result.value?.configured === true)
  check('query: keeps the currency', result.value?.wallets?.[0]?.currency === 'CNY')
  check('query: keeps total as a string', result.value?.wallets?.[0]?.totalBalance === '12.34')
  check('query: keeps granted', result.value?.wallets?.[0]?.grantedBalance === '2.00')
  check('query: keeps topped up', result.value?.wallets?.[0]?.toppedUpBalance === '10.34')
  check('query: reports availability', result.value?.isAvailable === true)
  check('query: stamps a fetch time', typeof result.value?.fetchedAt === 'number')
  check('query: is not stale on a fresh read', result.value?.stale === false)
  check('query: calls the balance URL', fetchCalls.calls[0]?.url === 'https://api.deepseek.com/user/balance')
  check('query: uses GET', fetchCalls.calls[0]?.init?.method === 'GET')
  check(
    'query: sends the key as a bearer header',
    fetchCalls.calls[0]?.init?.headers?.authorization === `Bearer ${API_KEY}`,
  )
  check('no leak: the key is absent from the result', !JSON.stringify(result).includes(API_KEY))
}

{
  // The cache must absorb a second read inside the fresh window.
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  const result = (await callHost(host, {})).result
  await callHost(host, {})
  const afterCached = fetchCalls.calls.length
  await callHost(host, { refresh: true })
  const afterRefresh = fetchCalls.calls.length
  fetchCalls.restore()
  check('cache: a second read inside the window makes one request', afterCached === 1)
  check('cache: refresh forces a request', afterRefresh === 2)
}

{
  // `is_available: false` is a valid reading, not a failure.
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() =>
    jsonResponse({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
    }),
  )
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('empty account: still a reading', result.ok === true && result.value?.isAvailable === false)
  check('empty account: keeps the zero total', result.value?.wallets?.[0]?.totalBalance === '0.00')
}

{
  // A missing credential is a normal state, not an RPC failure.
  const host = await loadHost({})
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('no credential: answers ok with configured=false', result.ok === true && result.value?.configured === false)
  check('no credential: names the code', result.value?.error?.code === 'user-balance/not-configured')
  check('no credential: makes no network request', fetchCalls.calls.length === 0)
}

{
  // The environment is the fallback source, as in the model provider.
  const host = await loadHost({ env: { DEEPSEEK_API_TOKEN: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('env fallback: resolves the second reference', result.value?.configured === true)
  check('env fallback: sends the key', fetchCalls.calls[0]?.init?.headers?.authorization === `Bearer ${API_KEY}`)
}

{
  // A stored credential wins over the environment.
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY }, env: { DEEPSEEK_API_KEY: 'sk-ENV' } })
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  await callHost(host, {})
  fetchCalls.restore()
  check('precedence: the stored key wins', fetchCalls.calls[0]?.init?.headers?.authorization === `Bearer ${API_KEY}`)
}

/* ---------------------------------------------------------------- *
 * Failure behavior
 * ---------------------------------------------------------------- */

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse({ error: 'nope' }, 401))
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('http error: answers ok with an error code', result.ok === true)
  check('http error: names the code', result.value?.error?.code === 'user-balance/http-error')
  check('http error: keeps the status', result.value?.error?.details?.status === 401)
  check('http error: no leak in the message', !JSON.stringify(result).includes(API_KEY))
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => {
    throw new Error(`connect ECONNREFUSED with ${API_KEY}`)
  })
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('network throw: answers ok with an error', result.ok === true && result.value?.error !== undefined)
  check('network throw: names the code', result.value?.error?.code === 'user-balance/request-failed')
  check(
    'no leak: the key is absent from every warning line',
    host.warnings.every((line) => !line.includes(API_KEY)),
    host.warnings.join(' | '),
  )
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse({ is_available: true, balance_infos: [] }))
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('bad shape: empty wallet list is an error', result.value?.error?.code === 'user-balance/bad-response')
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse('not json at all'))
  const result = (await callHost(host, {})).result
  fetchCalls.restore()
  check('bad shape: non-JSON is an error', result.value?.error?.code === 'user-balance/bad-response')
}

{
  // A stale cache must survive a later outage.
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  let mode = 'ok'
  const fetchCalls = installFetch(() => {
    if (mode === 'ok') return jsonResponse(HEALTHY)
    throw new Error('offline')
  })
  await callHost(host, {})
  mode = 'down'
  // Force the fresh window past by asking for a refresh.
  const result = (await callHost(host, { refresh: true })).result
  fetchCalls.restore()
  check('stale cache: an outage still answers a reading', result.ok === true && result.value?.configured === true)
  check('stale cache: the reading is marked stale', result.value?.stale === true)
  check('stale cache: keeps the last total', result.value?.wallets?.[0]?.totalBalance === '12.34')
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const badMethod = await callHost(host, { method: 'drop-tables' })
  const wrongMethod = await callHost(host, { method: 'query' }, { rpcMethod: 'session/list' })
  const wrongContentType = await callHost(host, { method: 'query' }, { contentType: 'text/plain' })
  const badJson = await callHost(host, {}, { rawBody: 'not json' })
  const wrongHttp = await callHost(host, {}, { method: 'GET' })
  check('dispatch: an unknown method is refused', badMethod.body?.result?.ok === false)
  check('dispatch: an unknown method names its code', badMethod.body?.result?.error?.code === 'user-balance/bad-request')
  check('dispatch: a foreign endpoint is refused', wrongMethod.body?.result?.error?.code === 'user-balance/bad-request')
  check('dispatch: refusals carry details', typeof badMethod.body?.result?.error?.details === 'object')
  check('dispatch: a wrong content type is 415', wrongContentType.status === 415)
  check('dispatch: a non-JSON body is 400', badJson.status === 400)
  check('dispatch: a GET is 405', wrongHttp.status === 405)
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const fetchCalls = installFetch(() => jsonResponse(HEALTHY))
  const result = (await callHost(host, { apiBase: 'https://proxy.example.com/v1/' })).result
  fetchCalls.restore()
  check('api base: an override is honored', fetchCalls.calls[0]?.url === 'https://proxy.example.com/user/balance')
  check('api base: the override still answers', result.value?.configured === true)
}

{
  const host = await loadHost({ values: { DEEPSEEK_API_KEY: API_KEY } })
  const result = (await callHost(host, { apiBase: 'file:///etc/passwd' })).result
  check('api base: a non-HTTP base is refused', result.value?.error?.code === 'user-balance/bad-api-base')
}

/* ---------------------------------------------------------------- *
 * Client half
 * ---------------------------------------------------------------- */

/** Minimal React: enough for one function component with hooks. */
function makeReact() {
  const instances = []
  const pendingEffects = []
  let current = null
  let cursor = 0
  const hooks = {
    useState(initial) {
      const index = cursor
      cursor += 1
      if (current.state[index] === undefined) current.state[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        current.state[index] = typeof next === 'function' ? next(current.state[index]) : next
      }
      return [current.state[index], setter]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (current.refs[index] === undefined) current.refs[index] = { current: initial }
      return current.refs[index]
    },
    useMemo(factory) {
      const index = cursor
      cursor += 1
      if (current.memos[index] === undefined) current.memos[index] = factory()
      return current.memos[index]
    },
    useCallback(fn) {
      const index = cursor
      cursor += 1
      if (current.callbacks[index] === undefined) current.callbacks[index] = fn
      return current.callbacks[index]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = current.deps[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        deps.length !== previous.length ||
        deps.some((dep, at) => dep !== previous[at])
      current.deps[index] = deps
      if (changed) pendingEffects.push(fn)
    },
  }
  /** A DOM node good enough for `getBoundingClientRect` and size reads. */
  function fakeElement(width, height, left) {
    return {
      offsetWidth: width,
      offsetHeight: height,
      contains: () => false,
      getBoundingClientRect: () => ({ left, right: left + 40, top: 700, bottom: 720, width: 40, height: 20 }),
    }
  }

  /** Wire a ref the way React does: an object ref gets `.current`, a fn ref is called. */
  function wireRef(ref, node) {
    if (typeof ref === 'function') {
      ref(node)
      return ref
    }
    if (ref !== null && ref !== undefined && typeof ref === 'object') {
      ref.current = node
      return ref
    }
    return { current: node }
  }

  const React = {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      const built = { ...(props || {}), children: children.length <= 1 ? children[0] : children }
      // A fixed-position panel has no intrinsic size in this stub, so the
      // component's measuring pass needs a node with sizes.
      if (built.className === 'dsh-user-balance-panel') built.ref = wireRef(built.ref, fakeElement(320, 180, 100))
      if (built.className === 'dsh-user-balance') built.ref = wireRef(built.ref, fakeElement(80, 20, 600))
      return { type, props: built }
    },
    useState: hooks.useState,
    useRef: hooks.useRef,
    useMemo: hooks.useMemo,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    // Layout effects run like ordinary effects in this stub: there is no paint.
    useLayoutEffect: hooks.useEffect,
    /** Render one element tree; state persists, changed effects run. */
    __render(element) {
      current = instances.length > 0 ? instances[instances.length - 1] : { state: [], refs: [], memos: [], callbacks: [], deps: [], cleanups: [] }
      if (instances.length === 0) instances.push(current)
      cursor = 0
      const tree = element.type(element.props)
      const run = pendingEffects.splice(0)
      for (const effect of run) current.cleanups.push(effect())
      return tree
    },
    /** Render the chip inside its fragment, so `children` hold root + panel. */
    __renderParts(element) {
      const tree = React.__render(element)
      return tree && tree.type === React.Fragment ? tree.props.children : tree
    },
    /** Run every cleanup registered by the renders. */
    __unmount() {
      for (const instance of instances) for (const cleanup of instance.cleanups) if (typeof cleanup === 'function') cleanup()
      instances.length = 0
    },
    /** Let queued promise callbacks settle. */
    async __settle() {
      for (let index = 0; index < 20; index += 1) await Promise.resolve()
    },
  }
  return React
}

/**
 * The trigger element: the chip may sit behind the root wrapper span.
 * @param parts - the fragment children from `__renderParts`.
 * @returns the trigger element.
 */
function chipOf(parts) {
  const first = parts[0]
  if (first === null || first === undefined) return first
  if (first.props && first.props.className === 'dsh-user-balance-root') return first.props.children
  return first
}

/** Walk a virtual tree and collect every string. */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props !== undefined) collectText(node.props.children, out)
  return out
}

/** Load the Client bundle with a React stub and a captured registration. */
async function loadClient() {
  const React = makeReact()
  const registrations = []
  const source = await readFile(`${PROJECT}lib/client.js`, 'utf8')
  let loaded = null
  /** Services a real cordis scope exposes as properties. */
  const injectable = new Set(['slots', 'connection', 'locale', 'effect', 'inject'])
  const scope = {
    slots: {
      inject(name, callback) {
        registrations.push({ name, entry: callback() })
      },
      register(options, component) {
        return { options, component }
      },
    },
    connection: {
      rpc: {
        calls: [],
        result: {
          ok: true,
          value: {
            configured: true,
            isAvailable: true,
            // The Host always stamps a reading; the panel shows it.
            fetchedAt: 1792154930877,
            wallets: [{ currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.00', toppedUpBalance: '10.34' }],
          },
        },
        call(channel, endpoint, payload, signal) {
          this.calls.push({ channel, endpoint, payload, signal })
          return Promise.resolve(this.result)
        },
      },
    },
    locale: { register: () => () => {} },
    effect: (fn) => fn(),
    inject(names, callback) {
      callback(scope)
    },
    /** Mirrors `ctx.get`: a plain lookup that never throws. */
    get(name) {
      if (name === 'locale') return scope.locale
      if (name === 'slots') return scope.slots
      if (name === 'connection') return scope.connection
      return undefined
    },
  }
  // A cordis scope refuses an undeclared service with a thrown error. Reading
  // `ctx.locale` with an empty `inject` list therefore throws, and inside
  // `apply` that throw skips every later registration.
  const strict = new Proxy(scope, {
    get(target, property) {
      if (typeof property === 'symbol' || property === 'get' || injectable.has(property)) {
        return Reflect.get(target, property)
      }
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const vm = await import('node:vm')
  const styleTags = []
  const documentStub = {
    head: { appendChild: (tag) => styleTags.push(tag) },
    getElementById: (id) => styleTags.find((tag) => tag.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const sandbox = {
    window,
    document: documentStub,
    navigator: { language: 'en-US' },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    AbortController,
    Promise,
    console,
    Date,
    Number,
    Math,
    JSON,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  check('client: registers a module', loaded !== null && typeof loaded.factory === 'function')
  check('client: the module id matches the package name', loaded?.id === 'dsh-user-balance')
  const exports = loaded.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  // Apply through the strict facade, so an undeclared service read fails here
  // exactly as it failed in the browser.
  exports.apply(strict)
  return { exports, React, scope, strict, registrations, sandbox, styleTags }
}

{
  // A client entry that throws takes the whole boot screen down, so apply must
  // absorb every failure.
  const { exports, React, sandbox } = await loadClient()
  let threw = null
  for (const hostile of [
    undefined,
    {},
    { inject() { throw new Error('inject exploded') }, effect() { throw new Error('effect exploded') } },
    { inject(names, callback) { callback({}) }, effect() {}, locale: { register() { throw new Error('locale exploded') } } },
  ]) {
    try {
      exports.apply(hostile)
    } catch (error) {
      threw = `${String(hostile)}: ${error.message}`
    }
  }
  check('client: apply never throws on a hostile context', threw === null, String(threw))
  // The loader call itself must also survive a hostile page.
  const source = await readFile(`${PROJECT}lib/client.js`, 'utf8')
  const vm = await import('node:vm')
  check('client: the bundle only touches window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(/.test(source))
  void React
  void sandbox
  void vm
}

{
  const { exports, registrations } = await loadClient()
  check('client: declares its name', exports.name === 'user-balance-client')
  // A hard inject list can leave the entry pending or failed, and a failed
  // client entry takes the whole boot screen down.
  check('client: declares no hard injection', Array.isArray(exports.inject) && exports.inject.length === 0)
  check('client: injects one slot', registrations.length === 1)
  // The composer dock is the stats row below the card: StatsPills, then the
  // context meter. Slot order 20 places this chip between them.
  check('client: registers into the stats row', registrations[0]?.name === 'conversation.composer.dock')
  check('client: uses a stable entry id', registrations[0]?.entry?.options?.id === 'user-balance')
  // A negative order puts the chip at the head of the stats row, before the
  // shipped entries. ContextMeter renders after the slot, so it stays last.
  check('client: sits at the head of the stats row', registrations[0]?.entry?.options?.order === -100)
  check('client: projects a label', typeof registrations[0]?.entry?.options?.label === 'function')
}

{
  const { registrations, React, scope } = await loadClient()
  const component = registrations[0].entry.component
  const tree = React.__render(component({ connection: scope.connection }))
  const loading = collectText(tree).join(' ')
  check('render: shows a loading state first', loading.includes('Balance'), loading)
  await React.__settle()
  React.__unmount()
  check('render: calls the RPC endpoint', scope.connection.rpc.calls[0]?.endpoint === 'user-balance')
  check('render: calls the shared /api channel', scope.connection.rpc.calls[0]?.channel === '/api')
  check('render: sends method=query', scope.connection.rpc.calls[0]?.payload?.method === 'query')
  check('render: the first read is not a forced refresh', scope.connection.rpc.calls[0]?.payload?.refresh === false)
}

{
  // After the first result the chip must show the amount, not the loading text.
  const { registrations, React, scope } = await loadClient()
  const component = registrations[0].entry.component
  let tree = React.__render(component({ connection: scope.connection }))
  await React.__settle()
  // A second render observes the state written by the resolved promise.
  tree = React.__render(component({ connection: scope.connection }))
  const text = collectText(tree).join(' ')
  check('render: shows the total after the first read', text.includes('12.34'), text)
  check('render: uses a currency symbol, not the code', text.includes('¥') && !text.includes('CNY'), text)
  const button = chipOf(React.__renderParts(component({ connection: scope.connection })))
  check('render: names the currency code for assistive technology', String(button.props?.['aria-label'] || '').includes('CNY'), String(button.props?.['aria-label']))
  check('render: no native tooltip is set', button.props?.title === undefined, String(button.props?.title))
  check('render: the accessible name carries the breakdown', String(button.props?.['aria-label'] || '').includes('Granted'), String(button.props?.['aria-label']))
  React.__unmount()
}

{
  // Zero-wallet handling and the multi-currency join, through the exported
  // helpers the component uses.
  const { exports } = await loadClient()
  const t = (key) => key

  const bothZero = {
    configured: true,
    wallets: [
      { currency: 'USD', totalBalance: '0.00', grantedBalance: '0', toppedUpBalance: '0' },
      { currency: 'CNY', totalBalance: '0.00', grantedBalance: '0', toppedUpBalance: '0' },
    ],
  }
  check(
    'money: both zero shows both currencies',
    exports.chipText({ phase: 'ready', value: bothZero, message: '' }, t) === '$ 0.00, ¥ 0.00',
    exports.chipText({ phase: 'ready', value: bothZero, message: '' }, t),
  )

  const oneZero = {
    configured: true,
    wallets: [
      { currency: 'USD', totalBalance: '0.00', grantedBalance: '0', toppedUpBalance: '0' },
      { currency: 'CNY', totalBalance: '429.52', grantedBalance: '32.17', toppedUpBalance: '397.35' },
    ],
  }
  check(
    'money: a zero wallet is hidden',
    exports.chipText({ phase: 'ready', value: oneZero, message: '' }, t) === '¥ 429.52',
    exports.chipText({ phase: 'ready', value: oneZero, message: '' }, t),
  )

  const bothUsed = {
    configured: true,
    wallets: [
      { currency: 'USD', totalBalance: '3.50', grantedBalance: '0', toppedUpBalance: '3.50' },
      { currency: 'CNY', totalBalance: '429.52', grantedBalance: '32.17', toppedUpBalance: '397.35' },
    ],
  }
  check(
    'money: two non-zero wallets are joined',
    exports.chipText({ phase: 'ready', value: bothUsed, message: '' }, t) === '$ 3.50, ¥ 429.52',
    exports.chipText({ phase: 'ready', value: bothUsed, message: '' }, t),
  )

  check('money: USD uses the dollar sign', exports.currencySymbol('USD') === '$')
  check('money: CNY uses the yuan sign', exports.currencySymbol('CNY') === '¥')
  check('money: an unknown code falls back to the generic sign', exports.currencySymbol('EUR') === '¤')
  check(
    'money: a two-currency line carries one symbol per amount',
    exports.chipText({ phase: 'ready', value: bothUsed, message: '' }, t) === '$ 3.50, ¥ 429.52',
    exports.chipText({ phase: 'ready', value: bothUsed, message: '' }, t),
  )

  // The tooltip keeps the code, so the symbol is never ambiguous.
  const title = exports.summary(oneZero, t)
  check('summary: names the code beside the symbol', title.includes('¥ 429.52 CNY'), title)
  check('summary: hides the zero wallet too', !title.includes('USD'), title)
}

{
  // The chip shares the stats row with StatsPills and ContextMeter. It is a
  // `span` with the pill rules in the stylesheet, so no inline style and no
  // user-agent button style can change its look.
  const { registrations, React, scope, styleTags } = await loadClient()
  const component = registrations[0].entry.component
  React.__render(component({ connection: scope.connection }))
  const chip = chipOf(React.__renderParts(component({ connection: scope.connection })))
  check('render: the chip is a span, not a button', chip.type === 'span', String(chip.type))
  check('render: the chip carries the class', chip.props?.className === 'dsh-user-balance')
  check('render: the chip carries the DevTools data attribute', chip.props?.['data-dsh-user-balance'] === '')
  check('render: a span declares its role', chip.props?.role === 'button')
  check('render: a span declares its tab stop', chip.props?.tabIndex === 0)
  check('render: the chip sets no inline style', chip.props?.style === undefined, JSON.stringify(chip.props?.style))
  check('render: the chip has no type attribute', chip.props?.type === undefined)
  check(
    'render: the text cell carries its own class',
    Array.isArray(chip.props.children)
      ? chip.props.children[0]?.props?.className === 'dsh-user-balance-text'
      : chip.props.children?.props?.className === 'dsh-user-balance-text',
  )

  // The stylesheet, not the component, owns the pill look and its hover.
  const sheet = styleTags.map((tag) => tag.textContent).join('\n')
  check('style: the pill base rule is present', sheet.includes('span.dsh-user-balance{'))
  check('style: the trigger uses a transparent background', sheet.includes('background:transparent'))
  check('style: the trigger is borderless', sheet.includes('border:none'))
  check('style: the trigger uses the small radius, not a capsule', sheet.includes('border-radius:var(--dsw-radius-sm)'))
  check('style: the wrapper mirrors the context meter root', sheet.includes('.dsh-user-balance-root{flex:none;display:inline-flex}'))
  check('style: the trigger keeps the shipped font size token', sheet.includes('--dsh-content-font-size-secondary'))
  check('style: the pill keeps the shipped padding', sheet.includes('padding:1px 8px'))
  check('style: the pill keeps the shipped gap', sheet.includes('gap:6px'))
  check('style: the pill keeps the shipped display', sheet.includes('display:inline-flex'))
  check(
    'style: hover and the open state share one rule',
    sheet.includes('span.dsh-user-balance:hover,span.dsh-user-balance[aria-expanded="true"]{'),
  )
  check('style: the hover rule uses the shipped token', sheet.includes('background:var(--dsw-alias-interactive-bg-hover)'))
  check('style: the open state lifts the label colour', sheet.includes('color:var(--dsw-alias-label-secondary)'))
  React.__unmount()
}

{
  // A configured=false answer must say so instead of showing a number.
  const { registrations, React, scope } = await loadClient()
  scope.connection.rpc.result = {
    ok: true,
    value: { configured: false, error: { code: 'user-balance/not-configured', message: 'no key' } },
  }
  const component = registrations[0].entry.component
  React.__render(component({ connection: scope.connection }))
  await React.__settle()
  const tree = React.__render(component({ connection: scope.connection }))
  const button = chipOf(React.__renderParts(component({ connection: scope.connection })))
  const text = collectText(tree).join(' ')
  check('render: an unconfigured account says so', text.includes('No API key'), text)
  check('render: the accessible name explains where to store a key', String(button.props?.['aria-label'] || '').includes('Settings'), String(button.props?.['aria-label']))
  React.__unmount()
}

{
  // A transport failure must not crash the chip.
  const { registrations, React, scope } = await loadClient()
  scope.connection.rpc.call = () => Promise.reject(new Error('transport failure'))
  const component = registrations[0].entry.component
  React.__render(component({ connection: scope.connection }))
  await React.__settle()
  const tree = React.__render(component({ connection: scope.connection }))
  const text = collectText(tree).join(' ')
  check('render: a transport failure is shown as a failure', text.includes('Balance unavailable'), text)
  React.__unmount()
}

{
  const { registrations, React, scope } = await loadClient()
  const component = registrations[0].entry.component
  React.__render(component({ connection: scope.connection }))
  await React.__settle()
  const closed = React.__renderParts(component({ connection: scope.connection }))
  const closedChip = chipOf(closed)
  check('interaction: the chip is closed first', String(closedChip.props['aria-expanded']) === 'false')
  check('interaction: a closed chip renders no panel', closed[1] === null || closed[1] === undefined)
  check(
    'interaction: the chip carries the DevTools hooks',
    closedChip.props.className === 'dsh-user-balance' && closedChip.props['data-dsh-user-balance'] === '',
  )
  check(
    'interaction: the chip sets no inline style',
    closedChip.props.style === undefined,
    JSON.stringify(closedChip.props.style),
  )

  // A click toggles the panel; it does not refresh.
  const callsBefore = scope.connection.rpc.calls.length
  closedChip.props.onClick()
  const opened = React.__renderParts(component({ connection: scope.connection }))
  const openedChip = chipOf(opened)
  check('interaction: a click opens the panel', String(openedChip.props['aria-expanded']) === 'true')
  // The toggled background is the stylesheet's `[aria-expanded="true"]` rule, so
  // the open state is asserted through that attribute.
  check(
    'interaction: the open state is expressed on the chip',
    openedChip.props['aria-expanded'] === 'true',
  )
  const panel = opened[1]
  check('interaction: the panel is rendered', panel !== null && panel !== undefined)
  check(
    'interaction: the panel is a dialog with the DevTools hook',
    panel?.props?.role === 'dialog' && panel?.props?.['data-dsh-user-balance-panel'] === '',
  )
  check(
    'interaction: opening makes no network call',
    scope.connection.rpc.calls.length === callsBefore,
    String(scope.connection.rpc.calls.length),
  )

  // The panel carries the detail rows and a refresh action. The first read has
  // already resolved, so the rows hold real values.
  const panelText = collectText(panel).join(' ')
  check('panel: names the account balance', panelText.includes('Account balance'), panelText)
  check('panel: carries the granted row', panelText.includes('Granted'), panelText)
  check('panel: carries the topped-up row', panelText.includes('Topped up'), panelText)
  check('panel: the topped-up label is sentence case', !panelText.includes('Topped Up'), panelText)
  check('panel: carries the update time', panelText.includes('Updated'), panelText)
  check('panel: shows the amount', panelText.includes('12.34'), panelText)
  const detailGrid = panel.props.children[2]
  check('panel: rows come in label/value pairs', Array.isArray(detailGrid.props.children)
    && detailGrid.props.children.length % 2 === 0
    && detailGrid.props.children.length > 0,
  detailGrid.props.children.length)

  const action = panel.props.children[0].props.children[1]
  check('panel: the action is a refresh button', typeof action.props.onClick === 'function')
  check('panel: the refresh button is enabled when idle', action.props.disabled === false)
  const callsBeforeRefresh = scope.connection.rpc.calls.length
  action.props.onClick()
  const refreshing = React.__renderParts(component({ connection: scope.connection }))
  check(
    'panel: refreshing disables the button',
    refreshing[1].props.children[0].props.children[1].props.disabled === true,
  )
  await React.__settle()
  check(
    'panel: refresh bypasses the cache',
    scope.connection.rpc.calls.length === callsBeforeRefresh + 1
      && scope.connection.rpc.calls[scope.connection.rpc.calls.length - 1].payload?.refresh === true,
  )

  // Closing works too.
  const afterRefresh = React.__renderParts(component({ connection: scope.connection }))
  chipOf(afterRefresh).props.onClick()
  const reclosed = React.__renderParts(component({ connection: scope.connection }))
  check('interaction: a second click closes the panel', reclosed[1] === null || reclosed[1] === undefined)
  React.__unmount()
}

/* ---------------------------------------------------------------- *
 * Package contract
 * ---------------------------------------------------------------- */

{
  const manifest = JSON.parse(await readFile(`${PROJECT}package.json`, 'utf8'))
  check('package: name matches the bundle id', manifest.name === 'dsh-user-balance')
  check('package: declares a bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
  check('package: declares a web client', manifest.dsh?.client?.platform === 'web')
  check('package: materializes the client immediately', manifest.dsh?.client?.immediately === true)
  check('package: exports the client bundle', manifest.exports['./client'] === './lib/client.js')
  check('package: exports the host half', manifest.exports['.'].default === './lib/index.js')

  const patch = await readFile(`${PROJECT}cordis.patch.yml`, 'utf8')
  check('patch: inserts the row', patch.includes('- insert:'))
  check('patch: row name is the package name', patch.includes("name: 'dsh-user-balance'"))
  check('patch: row id is stable', patch.includes('id: user-balance'))

  // The profile holds a copy, not a symlink. A stale or absent copy loads the
  // wrong code, and a missing bundle row installs the plugin without loading it.
  const profiles = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileRoot = join(profiles, 'profiles', 'web')
  const profileManifestPath = join(profileRoot, 'package.json')
  try {
    const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
    check(
      'profile: the bundle row is present',
      (profileManifest.dsh?.profile?.bundles ?? []).includes('dsh-user-balance'),
      (profileManifest.dsh?.profile?.bundles ?? []).join(', '),
    )
    check(
      'profile: the other plugins survived the install',
      (profileManifest.dsh?.profile?.bundles ?? []).includes('@happyqu/dsh-plugin-git'),
    )
    check('profile: the dependency is declared', profileManifest.dependencies?.['dsh-user-balance'] !== undefined)
    const installedLib = join(profileRoot, 'node_modules', 'dsh-user-balance', 'lib')
    for (const file of ['index.js', 'client.js']) {
      const [source, installed] = await Promise.all([
        readFile(`${PROJECT}lib/${file}`, 'utf8'),
        readFile(join(installedLib, file), 'utf8'),
      ])
      check(`profile: the installed ${file} matches this source`, source === installed)
    }
  } catch (error) {
    check('profile: the web profile is readable', false, String(error))
  }

  // The model provider's default credential reference must be one we try.
  const credentialsSource = await readFile(
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js',
    'utf8',
  )
  const defaultRef = /\.default\("([A-Z_]+)"\)/.exec(credentialsSource)?.[1]
  check('contract: the provider default reference is tried first', defaultRef === 'DEEPSEEK_API_KEY', String(defaultRef))

  // No tool and no prompt contribution: the plugin must not reach a model turn.
  const hostSource = await readFile(`${PROJECT}lib/index.js`, 'utf8')
  check('contract: registers no tool', !/ctx\.tools|registerTool|tool\(/.test(hostSource))
  check('contract: registers no prompt section', !/systemPrompt|promptSection/.test(hostSource))

  // The profile installs the plugin outside the Harness package tree, so a bare
  // import cannot resolve and the loader row would fail the whole profile.
  const hostSpecifiers = [...hostSource.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)]
    .map((match) => match[1])
  const dynamicSpecifiers = [...hostSource.matchAll(/await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  check(
    'contract: the Host half imports nothing',
    hostSpecifiers.length === 0 && dynamicSpecifiers.length === 0,
    [...hostSpecifiers, ...dynamicSpecifiers].join(', '),
  )

  const clientSource = await readFile(`${PROJECT}lib/client.js`, 'utf8')
  const clientSpecifiers = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  const allowedRequires = new Set(['react', 'react-dom'])
  check(
    'contract: the Client half requires only the platform seed modules',
    clientSpecifiers.every((specifier) => allowedRequires.has(specifier)),
    clientSpecifiers.join(', '),
  )

  // With an empty `inject` list cordis throws on an undeclared service read.
  // Inside `apply` that throw skips every registration after it, so the file
  // must reach those services through `ctx.get` only.
  const codeOnly = clientSource
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const bareServiceReads = [...codeOnly.matchAll(/\bctx\.(locale|slots|connection|theme|store)\b/g)]
    .map((match) => match[1])
  check(
    'contract: the Client half reads non-injected services through ctx.get',
    bareServiceReads.length === 0,
    bareServiceReads.join(', '),
  )
}

/* ---------------------------------------------------------------- *
 * Report
 * ---------------------------------------------------------------- */

await rm(CANDIDATE, { recursive: true, force: true }).catch(() => {})
for (let index = 1; index <= generation; index += 1) {
  await rm(`${CANDIDATE}-${String(index)}`, { recursive: true, force: true }).catch(() => {})
}

const total = passed + failures.length
if (failures.length === 0) {
  console.log(`OK — ${String(total)} checks passed`)
  process.exit(0)
}
console.log(`FAILED — ${String(failures.length)} of ${String(total)} checks failed`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
process.exit(1)
