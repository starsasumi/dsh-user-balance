/**
 * dsh-user-balance — Browser half.
 *
 * Renders the balance chip in the composer stats row. Every network call goes
 * through the Host, so this half never sees the API key.
 */
window.__ModuleLoader__.load({
  id: 'dsh-user-balance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var ReactMod = require('react')
    // A CJS React export carries createElement directly; an ESM namespace puts it on .default.
    var React = ReactMod && ReactMod.createElement ? ReactMod : ReactMod.default
    var h = React.createElement

    var RPC_ENDPOINT = 'user-balance'
    var RPC_CHANNEL = '/api'

    /** Dictionary namespace owned by this plugin. */
    var NS = 'userBalance'

    /** How often the chip re-reads the balance. */
    var REFRESH_MS = 5 * 60 * 1000

    /** Injected stylesheet id. One sheet per page, shared by every chip. */
    var STYLE_ID = 'dsh-user-balance-style'

    var dictionary = {
      zh: {
        'chip.label': '账户余额',
        'chip.hint': '点击查看 DeepSeek 账户余额详情',
        'chip.loading': '余额 …',
        'chip.none': '余额 —',
        'chip.notConfigured': '未配置 API Key',
        'chip.notConfigured.hint': '在 设置 → 模型 里保存 DeepSeek API Key。',
        'chip.failed': '余额不可用',
        'chip.granted': '赠送',
        'chip.toppedUp': '充值',
        'chip.total': '总额',
        'chip.updated': '更新时间',
        'chip.unavailable': '余额不足，API 调用会被拒绝',
        'chip.stale': '（缓存值）',
        'chip.refresh': '刷新',
        'chip.refreshing': '刷新中…',
      },
      en: {
        'chip.label': 'Account balance',
        'chip.hint': 'Click for DeepSeek account balance details',
        'chip.loading': 'Balance …',
        'chip.none': 'Balance —',
        'chip.notConfigured': 'No API key',
        'chip.notConfigured.hint': 'Save a DeepSeek API key in Settings → Models.',
        'chip.failed': 'Balance unavailable',
        'chip.granted': 'Granted',
        'chip.toppedUp': 'Topped up',
        'chip.total': 'Total',
        'chip.updated': 'Updated',
        'chip.unavailable': 'Balance is insufficient, API calls are refused',
        'chip.stale': '(cached)',
        'chip.refresh': 'Refresh',
        'chip.refreshing': 'Refreshing…',
      },
    }

    /**
     * The stylesheet for the chip and its details panel.
     *
     * The chip rules match the context meter trigger. The panel rules match the
     * session-statistics panel of `dsh-client-ui-chat`.
     */
    var STYLES = [
      'span.dsh-user-balance{border-radius:var(--dsw-radius-sm);',
      '  color:var(--dsw-alias-label-tertiary);font-family:inherit;',
      '  font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;',
      '  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;',
      '  background:transparent;border:none;cursor:pointer;flex:none;',
      '  align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      'span.dsh-user-balance:hover,span.dsh-user-balance[aria-expanded="true"]{',
      '  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      'span.dsh-user-balance:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l2)}',
      '.dsh-user-balance-root{flex:none;display:inline-flex}',
      '.dsh-user-balance-text{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dsh-user-balance-panel{z-index:1100;box-sizing:border-box;position:fixed;',
      '  border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      '  min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));',
      '  backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '  box-shadow:0 0 0 .5px var(--dsw-alias-border-l1),var(--dsw-elevation-prominent);',
      '  color:var(--dsw-alias-label-secondary);cursor:default;padding:16px;',
      '  font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '.dsh-user-balance-panel-title{color:var(--dsw-alias-label-primary);',
      '  justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;',
      '  font-weight:500;display:flex}',
      '.dsh-user-balance-panel-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dsh-user-balance-panel-details{color:var(--dsw-alias-label-tertiary);',
      '  grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
      '.dsh-user-balance-panel-details > span:nth-child(even){text-align:right}',
      '.dsh-user-balance-panel-action{border:none;background:transparent;font:inherit;',
      '  color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px 8px;border-radius:999px}',
      '.dsh-user-balance-panel-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-user-balance-panel-action:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
    ].join('\n')

    /** Install the stylesheet once. */
    function installStyles() {
      if (typeof document === 'undefined') return
      var existing = document.getElementById(STYLE_ID)
      if (existing !== null) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /** Pick a dictionary from the active UI language, without a locale service. */
    function fallbackText() {
      var lang = 'en'
      try {
        lang = String(navigator.language || 'en')
      } catch (error) {
        lang = 'en'
      }
      var table = lang.toLowerCase().indexOf('zh') === 0 ? dictionary.zh : dictionary.en
      return function (key) {
        return table[key] === undefined ? key : table[key]
      }
    }

    /**
     * Call the Host endpoint.
     *
     * A missing Connection service rejects. The chip then shows a failure.
     *
     * @param connection - the browser Connection service.
     * @param payload - request payload.
     * @param signal - caller cancellation.
     * @returns the endpoint result envelope.
     */
    function callBalance(connection, payload, signal) {
      if (connection === undefined || connection === null || connection.rpc === undefined) {
        return Promise.reject(new Error('no connection service'))
      }
      try {
        return Promise.resolve(connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, payload, signal))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    /**
     * Normalize one balance string for display, or null when unusable.
     *
     * The API reports money as a two-decimal string. A value that is not a
     * finite number is kept as written.
     */
    function formatMoney(value) {
      if (typeof value !== 'string' || value === '') return null
      var number = Number(value)
      if (!Number.isFinite(number)) return value
      return number.toFixed(2)
    }

    /** The currency symbol for one code: `¥`, `$`, or `¤` (U+00A4). */
    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return '¤'
    }

    /** Whether one balance string is a real, non-zero amount. */
    function isZeroAmount(value) {
      var text = formatMoney(value)
      if (text === null) return true
      var number = Number(text)
      return Number.isFinite(number) && number === 0
    }

    /**
     * The wallets to show: the non-zero ones, or all of them when every one is zero.
     *
     * @param value - the Host reading.
     * @returns the wallets to render, in API order.
     */
    function visibleWallets(value) {
      if (value === null || typeof value !== 'object') return []
      var wallets = Array.isArray(value.wallets) ? value.wallets : []
      var nonZero = wallets.filter(function (wallet) {
        return !isZeroAmount(wallet.totalBalance)
      })
      return nonZero.length > 0 ? nonZero : wallets
    }

    /** One amount with its currency symbol: `¥ 429.52`. */
    function amountText(wallet) {
      var total = formatMoney(wallet.totalBalance)
      return currencySymbol(wallet.currency) + ' ' + (total === null ? '—' : total)
    }

    /** The multi-line summary used as the accessible name. */
    function summary(value, t) {
      if (value === null || typeof value !== 'object') return ''
      var wallets = visibleWallets(value)
      if (wallets.length === 0) return ''
      var lines = []
      for (var index = 0; index < wallets.length; index += 1) {
        var wallet = wallets[index]
        var symbol = currencySymbol(wallet.currency)
        var total = formatMoney(wallet.totalBalance)
        if (total !== null) lines.push(t('chip.label') + ': ' + symbol + ' ' + total + ' ' + wallet.currency)
        var granted = formatMoney(wallet.grantedBalance)
        if (granted !== null) lines.push(t('chip.granted') + ': ' + symbol + ' ' + granted)
        var toppedUp = formatMoney(wallet.toppedUpBalance)
        if (toppedUp !== null) lines.push(t('chip.toppedUp') + ': ' + symbol + ' ' + toppedUp)
      }
      if (value.isAvailable === false) lines.push(t('chip.unavailable'))
      return lines.join('\n')
    }

    /** The visible chip text. */
    function chipText(state, t) {
      if (state.phase === 'loading') return t('chip.loading')
      if (state.phase === 'failed') return t('chip.failed')
      if (state.value === null) return t('chip.none')
      if (state.value.configured === false) return t('chip.notConfigured')
      var wallets = visibleWallets(state.value)
      if (wallets.length === 0) return t('chip.failed')
      var parts = []
      for (var index = 0; index < wallets.length; index += 1) {
        parts.push(amountText(wallets[index]))
      }
      var text = parts.join(', ')
      if (state.value.stale === true) text += ' ' + t('chip.stale')
      return text
    }

    /** The accessible name: the summary, or why the chip is empty. */
    function chipTitle(state, t) {
      if (state.phase === 'loading') return t('chip.hint')
      if (state.phase === 'failed') return state.message || t('chip.failed')
      if (state.value === null) return t('chip.hint')
      if (state.value.configured === false) return t('chip.notConfigured.hint')
      var text = summary(state.value, t)
      return text === '' ? t('chip.hint') : text
    }

    /** One row of the panel: a label cell and a right-aligned value cell. */
    function detailRow(key, label, value) {
      return [
        h('span', { key: key + '-label' }, label),
        h('span', { key: key + '-value' }, value),
      ]
    }

    /** A clock time for the panel, or null when the stamp is unusable. */
    function formatTime(stamp) {
      if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return null
      try {
        return new Date(stamp).toLocaleTimeString()
      } catch (error) {
        return null
      }
    }

    /** The panel cells: one block per shown wallet, or the failure reason. */
    function detailEntries(state, t) {
      var rows = []
      var value = state.value
      if (value !== null && value.configured === false) {
        rows = rows.concat(detailRow('state', t('chip.label'), t('chip.notConfigured')))
        rows = rows.concat(detailRow('hint', '', t('chip.notConfigured.hint')))
        return rows
      }
      if (state.phase === 'failed') {
        rows = rows.concat(detailRow('state', t('chip.label'), t('chip.failed')))
        if (state.message) rows = rows.concat(detailRow('reason', '', state.message))
        return rows
      }
      var wallets = visibleWallets(value)
      for (var index = 0; index < wallets.length; index += 1) {
        var wallet = wallets[index]
        var symbol = currencySymbol(wallet.currency)
        var prefix = wallets.length > 1 ? wallet.currency + ' ' : ''
        var total = formatMoney(wallet.totalBalance)
        rows = rows.concat(detailRow('total-' + String(index), prefix + t('chip.total'), symbol + ' ' + (total === null ? '—' : total)))
        var granted = formatMoney(wallet.grantedBalance)
        if (granted !== null) rows = rows.concat(detailRow('granted-' + String(index), t('chip.granted'), symbol + ' ' + granted))
        var toppedUp = formatMoney(wallet.toppedUpBalance)
        if (toppedUp !== null) rows = rows.concat(detailRow('topped-' + String(index), t('chip.toppedUp'), symbol + ' ' + toppedUp))
      }
      if (value !== null && value.isAvailable === false) {
        rows = rows.concat(detailRow('available', '', t('chip.unavailable')))
      }
      var when = value === null ? null : formatTime(value.fetchedAt)
      if (when !== null) rows = rows.concat(detailRow('updated', t('chip.updated'), when))
      return rows
    }

    /** The balance chip and its details panel. */
    function BalanceChip(props) {
      var t = props.t || fallbackText()
      var connection = props.connection
      var initial = { phase: 'loading', value: null, message: '' }
      var pair = React.useState(initial)
      var state = pair[0]
      var setState = pair[1]

      React.useEffect(function () {
        var controller = new AbortController()
        var live = true
        var read = function (refresh) {
          setState(function (current) {
            return { phase: 'loading', value: current.value, message: '' }
          })
          callBalance(connection, { method: 'query', refresh: refresh === true }, controller.signal).then(
            function (result) {
              if (!live) return
              if (result !== null && result !== undefined && result.ok === true) {
                setState({ phase: 'ready', value: result.value, message: '' })
                return
              }
              var message = result !== null && result !== undefined && result.error !== undefined
                ? String(result.error.message || '')
                : ''
              setState({ phase: 'failed', value: null, message: message })
            },
            function (error) {
              if (!live) return
              setState({ phase: 'failed', value: null, message: String((error && error.message) || error) })
            },
          )
        }
        read(false)
        var timer = setInterval(function () {
          read(true)
        }, REFRESH_MS)
        return function () {
          live = false
          clearInterval(timer)
          controller.abort()
        }
      }, [connection])

      // The panel refresh outlives the panel, so it lives outside the effect above.
      var refreshNow = React.useCallback(function () {
        setState(function (current) {
          return { phase: 'loading', value: current.value, message: '' }
        })
        callBalance(connection, { method: 'query', refresh: true }).then(
          function (result) {
            if (result !== null && result !== undefined && result.ok === true) {
              setState({ phase: 'ready', value: result.value, message: '' })
              return
            }
            var message = result !== null && result !== undefined && result.error !== undefined
              ? String(result.error.message || '')
              : ''
            setState({ phase: 'failed', value: null, message: message })
          },
          function (error) {
            setState({ phase: 'failed', value: null, message: String((error && error.message) || error) })
          },
        )
      }, [connection])

      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var rootRef = React.useRef(null)
      var panelRef = React.useRef(null)
      var posPair = React.useState(null)
      var pos = posPair[0]
      var setPos = posPair[1]

      /** Place the panel above the chip, left-aligned, clamped to the viewport. */
      var place = React.useCallback(function () {
        var root = rootRef.current
        var panel = panelRef.current
        if (root === null || panel === null) return
        var rect = root.getBoundingClientRect()
        var width = panel.offsetWidth
        var margin = 12
        var left = Math.min(
          Math.max(margin, rect.left),
          Math.max(margin, globalThis.innerWidth - width - margin),
        )
        setPos({ left: left, bottom: Math.max(margin, globalThis.innerHeight - rect.top + 8) })
      }, [])

      React.useLayoutEffect(function () {
        if (!open) return undefined
        place()
        var onResize = function () {
          place()
        }
        globalThis.addEventListener('resize', onResize)
        return function () {
          globalThis.removeEventListener('resize', onResize)
        }
      }, [open, place])

      React.useEffect(function () {
        if (!open) return undefined
        var onPointerDown = function (event) {
          var root = rootRef.current
          var panel = panelRef.current
          var target = event.target
          if (root !== null && root.contains(target)) return
          if (panel !== null && panel.contains(target)) return
          setOpen(false)
        }
        var onKeyDown = function (event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      var refreshLabel = state.phase === 'loading' ? t('chip.refreshing') : t('chip.refresh')
      var panel = open
        ? h(
            'div',
            {
              key: 'panel',
              ref: panelRef,
              className: 'dsh-user-balance-panel',
              role: 'dialog',
              'aria-label': t('chip.label'),
              'data-dsh-user-balance-panel': '',
              style: pos === null
                ? { visibility: 'hidden', left: '0px', bottom: '0px' }
                : { left: pos.left + 'px', bottom: pos.bottom + 'px' },
            },
            h(
              'div',
              { className: 'dsh-user-balance-panel-title' },
              h('span', null, t('chip.label')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-user-balance-panel-action',
                  onClick: refreshNow,
                  disabled: state.phase === 'loading',
                },
                refreshLabel,
              ),
            ),
            h('div', { className: 'dsh-user-balance-panel-rule' }),
            h('div', { className: 'dsh-user-balance-panel-details' }, detailEntries(state, t)),
          )
        : null

      var children = [
        h('span', {
          key: 'text',
          className: 'dsh-user-balance-text',
        }, chipText(state, t)),
      ]
      return h(
        React.Fragment,
        null,
        h(
          'span',
          { key: 'root', className: 'dsh-user-balance-root' },
          h(
            'span',
            {
              ref: rootRef,
              className: 'dsh-user-balance',
              'data-dsh-user-balance': '',
              role: 'button',
              tabIndex: 0,
              'aria-label': chipTitle(state, t),
              'aria-haspopup': 'dialog',
              'aria-expanded': open ? 'true' : 'false',
              onClick: function () {
                setOpen(!open)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                  event.preventDefault()
                  setOpen(!open)
                }
              },
            },
            children,
          ),
        ),
        panel,
      )
    }

    /** One diagnostic line, so a failure is visible in DevTools. */
    function note(text, error) {
      try {
        if (error === undefined) console.info(`[user-balance] ${text}`)
        else console.warn(`[user-balance] ${text}`, error)
      } catch (ignored) {
        // A logger that throws must not stop registration.
      }
    }

    /**
     * Register the chip. Soft injection keeps a missing service from failing
     * the entry. Each step logs one line for DevTools.
     *
     * @param ctx - browser application context.
     */
    function apply(ctx) {
      try {
        note('applying')
        var t = fallbackText()
        try {
          installStyles()
        } catch (error) {
          note('stylesheet install failed', error)
        }
        // `locale` is optional, and `inject` lists it nowhere.
        var locale = ctx.get === undefined ? undefined : ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(function () {
            return locale.register(NS, dictionary)
          }, 'user-balance: dictionaries')
        }
        ctx.inject(['slots', 'connection'], function (scope) {
          note('services injected; slots=' + typeof scope.slots + ' connection=' + typeof scope.connection)
          if (scope.slots === undefined || typeof scope.slots.inject !== 'function') {
            note('slots service unavailable; the chip is not registered')
            return
          }
          var connection = scope.connection
          scope.slots.inject('conversation.composer.dock', function () {
            try {
              var entry = scope.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'user-balance',
                  order: -100,
                  label: function () {
                    return t('chip.label')
                  },
                },
                function UserBalanceAction(actionProps) {
                  try {
                    return h(BalanceChip, {
                      connection: connection,
                      t: (actionProps && actionProps.t) || t,
                    })
                  } catch (error) {
                    // A throw in one cell must not reach the slot renderer.
                    return null
                  }
                },
              )
              note('registered into conversation.composer.dock')
              return entry
            } catch (error) {
              note('slot registration failed', error)
              return undefined
            }
          })
        })
      } catch (error) {
        note('client activation failed', error)
      }
    }

    exports.name = 'user-balance-client'
    exports.inject = []
    exports.apply = apply
    exports.BalanceChip = BalanceChip
    exports.chipText = chipText
    exports.summary = summary
    exports.currencySymbol = currencySymbol
    exports.visibleWallets = visibleWallets
    return module.exports
  },
})
