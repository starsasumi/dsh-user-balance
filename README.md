# dsh-user-balance

Shows the DeepSeek account balance in the DSH web GUI.

The chip sits in the composer stats row, next to the shipped statistics. A click
opens a panel with the totals and a refresh action.

| part | state |
|---|---|
| Host half | verified by `node scripts/verify.mjs` |
| Client half | verified by `node scripts/verify.mjs` against a stubbed React |
| Live Host and route | verified on a running `dsh web` |
| Live browser chip | not verified. No browser engine is available in the build container. |

## The API key

The key never reaches the model.

- The Host half is the only place the key exists.
- The key is read per query, sent as one request header, and never returned.
- The plugin registers no tool and no prompt section.
- Every diagnostic string is scrubbed of the key.
- The browser receives amounts only.

## What it reads

`GET <api-base>/user/balance`, with `Authorization: Bearer <key>`.

The credential reference order is:

1. `DEEPSEEK_API_KEY`
2. `DEEPSEEK_API_TOKEN`

The credentials service supplies the value first. The launch environment is the
fallback. The model provider uses the same order.

## Chip

| condition | text |
|---|---|
| no key configured | `No API key` |
| request running | `Balance …` |
| healthy | `¥ 429.52` |
| request failed, cache under 10 minutes old | the last reading, then `(cached)` |
| request failed, no usable cache | `Balance unavailable` |

### Money

| rule | example |
|---|---|
| CNY renders `¥`, USD renders `$` | `¥ 429.52`, `$ 3.50` |
| any other code renders `¤` (U+00A4) | `¤ 12.00` |
| amounts keep two decimals | `$ 3.50` |
| a zero wallet is hidden | `[USD 0.00, CNY 429.52]` renders `¥ 429.52` |
| all wallets zero keeps them all | `[USD 0.00, CNY 0.00]` renders `$ 0.00, ¥ 0.00` |
| several non-zero wallets are joined in API order | `$ 3.50, ¥ 429.52` |

## Refresh policy

| trigger | request |
|---|---|
| chip mounts | one read, cache allowed |
| every 5 minutes | one read, cache bypassed |
| panel **Refresh** | one read, cache bypassed |

| fact | value |
|---|---|
| cache window (`FRESH_MS`) | 60 seconds |
| stale window | 10 minutes |
| request deadline | 15 seconds |
| client interval (`REFRESH_MS`) | 5 minutes |

The Host cache is shared between sessions.

## Install

The plugin is a `file:` dependency of the DSH profile.

```sh
cd ~/.dsh/profiles/web
pnpm add file:/data/projects/dsh-user-balance
```

`pnpm add` and `dsh plugin … remove` rewrite `package.json`. Check two items
after either command:

1. `dependencies` still lists the other profile plugins.
2. `dsh.profile.bundles` still lists `dsh-user-balance`.

The bundle row is the switch. Without it, the plugin is installed and nothing
loads it.

No restart is needed. The profile recomposes live. A hard page reload picks up
the client bundle. `profile-backup/` holds the profile manifests from before the
install.

## Verify

```sh
node scripts/verify.mjs
```

The suite runs both halves against stubbed seams. The stubs cover the credentials
service, the launch environment, the HTTP route, and a minimal React. The suite
covers the no-leak property, the cache, the failure states, the route guards, and
the package contract.

It fails in two extra cases:

- The Host half gains an import.
- The Client half requires a module outside the platform seed table.

A live check posts the envelope:

```sh
curl -b jar -X POST http://127.0.0.1:<port>/api/user-balance \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"user-balance","payload":{"method":"query"}}'
```

## Limits

- The chip needs an open session. `conversation.composer.dock` is session-scoped.
- A `GET` on the route returns 404. The shared `/api` handler dispatches only the
  declared methods. The browser client always posts.
- A hand-written client bundle needs no build step and requests no module beyond
  React.
