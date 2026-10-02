# dsh-web-firecrawl

**Firecrawl as the web backend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
It adds no new tools: `web_search` and `web_fetch` keep working exactly as before, and this plugin
decides how they talk to Firecrawl.

```sh
dsh plugin --profile web add dsh-web-firecrawl
```

---

## Why this exists

The official [`@firecrawl/dsh-firecrawl`](https://github.com/firecrawl/dsh-firecrawl) pins
`peerDependencies` to `@deepseek-ai/dsh-web@0.1.0-rc.6`. DeepSeek Harness 0.2.0 added a
compatibility preflight that refuses any plugin whose `@deepseek-ai/dsh*` peers do not match the
running runtime — so the whole bundle is skipped, its patch layer is dropped, and `web_search`
silently falls back to a different backend.

This package declares **no `@deepseek-ai/*` peer dependencies at all** (and imports nothing from
them either). The preflight only reads `peerDependencies`, so it has nothing to refuse and the
plugin keeps working across dsh upgrades.

It also does more than forward a query:

| | official 0.1.0 | this package |
|---|---|---|
| loads on dsh 0.2.x | ❌ refused by the preflight | ✅ zero dsh peers |
| `categories` (research / developer / pdf) | ❌ not in its parameter surface | ✅ inferred from the query, **free** |
| `site:` / `-site:` operators | ❌ passed through as text | ✅ become hard `includeDomains` / `excludeDomains` filters |
| result quality | only `description` (~200 chars) | ✅ top-K upgraded on demand with `summary` (+1 credit, 4–7× the text); `question` returns an actual answer into the seam's `content` |
| repeated queries / URLs | billed again every time | ✅ in-process cache, 0 requests for 10 minutes |
| dead-end URLs | retried by the model | ✅ failure memory denies a repeat of a URL that cannot improve |
| credit safety | none | ✅ accounts real `creditsUsed`; auto-detects metered vs self-hosted |
| tool routing | none | ✅ a system-prompt table for when to use which Firecrawl MCP tool |

## Install

```sh
dsh plugin --profile web add dsh-web-firecrawl
```

`dsh plugin` runs pnpm inside the profile and registers the bundle in `dsh.profile.bundles`
automatically. Restart dsh afterwards — profile config is composed at boot.

Point it at your Firecrawl endpoint (project `.env` or the launching environment):

```sh
# self-hosted Firecrawl — no API key needed
FIRECRAWL_BASE_URL=https://firecrawl.example.com

# or the public API
FIRECRAWL_API_KEY=fc-your-key
```

Verify:

```sh
dsh --profile web --dump-config | grep -A3 '^- id: web$'
# want: searchProvider: firecrawl / fetchProvider: firecrawl
```

> **If you leave `FIRECRAWL_BASE_URL` unset** you get the **public, metered** API at
> `https://api.firecrawl.dev`. The plugin detects that, enables its credit caps, and logs a
> warning once — but that is already after money can be spent. Set the endpoint.

### Why the endpoint is not in the shipped config

cordis patches **replace** a config object rather than merging it (`target[key] = value`). If this
package shipped a `baseURL` in its patch, anyone who wrote their own `config:` for the same entry
would silently drop it and fall back to the public metered API. Endpoint and credential therefore
come from the environment, which DSH resolves through its launch-environment snapshot.

## What it does with a query

1. **Free filtering first.** Query intent picks a Firecrawl `categories` channel (`research`,
   `developer`, `pdf`); `site:` / `-site:` become `includeDomains` / `excludeDomains` and are
   stripped from the query text. `limit` is rounded up to the next 10-result band, because search
   bills 2 credits per 10 results — extra recall in the same band is free.
2. **On-demand enrichment instead of blanket scraping.** `scrapeOptions` bills *per result*, so
   scraping all eight is wasteful. The plugin scrapes only the top K (`enrichTopK`, default 1) and
   only when the free snippets look thin (`enrichMode: adaptive`). `summary` costs +1 credit and
   returns 4–7× the text; `question` costs +4 and returns a generated answer.
3. **A credit budget that matches reality.** `/v2/team/credit-usage` tells the plugin whether this
   backend bills at all: the public API and paid proxies answer with balance data, a self-hosted
   instance answers `500 UNKNOWN_ERROR` and even accepts a bogus key. Metered backends get credit
   caps; unmetered ones only get a runaway-call guard.
4. **Failure memory.** Unreachable sites, 404s, paywalls and empty pages are remembered, and a
   repeat fetch is denied with an instruction to change the source. Network wobble, 429 and 5xx
   are never remembered — those are worth retrying.

## Configuration

Every key is optional. Set them on the `web-firecrawl` entry in your profile's
`cordis.patch.yml` — **remember that a `config:` block replaces the whole config**, so repeat any
value you want to keep:

```yaml
- id: web-firecrawl
  config:
    enrichTopK: 1              # upgrade the top K results; 0 = bare search (cheapest)
    enrichFormat: summary      # summary (+1) | markdown (+1) | question (+4)
    enrichMode: adaptive       # or 'always'
    budgetWindowCredits: 60    # metered backends only: credits per 10 minutes
    budgetWindowCalls: 120     # both: runaway-loop guard
    minRemainingCredits: 0     # metered backends: stop when the balance drops below this
    failureTtlMs: 600000       # dead-end memory TTL; 0 = off, negative = until restart
    billingMode: auto          # auto | metered | unmetered
    routingPrompt: true        # publish the tool-choice table in the system prompt
```

<details>
<summary>All options</summary>

| key | default | meaning |
|---|---|---|
| `baseURL` | `https://api.firecrawl.dev` | endpoint; `FIRECRAWL_BASE_URL` wins over it |
| `apiKey` | `$FIRECRAWL_API_KEY` | omit entirely for self-hosted / rotating proxies |
| `timeoutMs` | `60000` | per-request Firecrawl budget |
| `searchBudgetMs` | `25000` | wall clock for one whole `search()`, enrichment included |
| `enrichTopK` | `1` | results to upgrade on demand |
| `enrichFormat` | `summary` | `summary` / `markdown` / `question` |
| `enrichQuestion` | — | question text when `enrichFormat: question` |
| `enrichMode` | `adaptive` | upgrade only when snippets are thin, or `always` |
| `thinSnippetChars` | `160` | "thin" threshold for adaptive mode |
| `maxSnippetChars` | `1400` | cap on a snippet handed to the model |
| `enrichTimeoutMs` | `20000` | cap for one enrichment scrape |
| `enrichMinRemainingMs` | `8000` | skip the upgrade rather than abort mid-flight |
| `inferCategories` | `true` | infer `categories` from the query |
| `parseSiteOperators` | `true` | turn `site:` into domain filters |
| `onlyMainContent` | `true` | drop boilerplate |
| `blockAds` | `true` | block ads during rendering |
| `maxAgeMs` | `172800000` | Firecrawl cache window (speed, not credits) |
| `waitForMs` | `0` | extra wait before snapshotting |
| `shellWaitForMs` | `2500` | wait used by the one JS-shell route change |
| `maxBodyChars` | `100000` | cap on a fetched body |
| `pdfMaxPages` | `20` | PDF parsing bills **per page** — this is the brake |
| `cacheTtlMs` | `600000` | in-process cache TTL (the only thing that saves credits) |
| `failureTtlMs` | `600000` | dead-end memory TTL; `0` off, negative until restart |
| `billingMode` | `auto` | `auto` / `metered` / `unmetered` |
| `billingProbeTimeoutMs` | `5000` | budget for the billing probe |
| `billingProbeTtlMs` | `600000` | how long a probed verdict is trusted (`0` = every call) |
| `budgetWindowMs` | `600000` | rolling window for both budgets |
| `budgetWindowCredits` | `60` | credits per window (metered only) |
| `budgetSessionCredits` | `300` | credits per process (metered only) |
| `minRemainingCredits` | `0` | stop below this reported balance (metered only) |
| `budgetWindowCalls` | `120` | calls per window (always) |
| `retryTransport` | `2` | retries for network wobble |
| `retryRateLimit` | `2` | retries for HTTP 429 (honours `Retry-After`) |
| `retryServer` | `1` | retries for HTTP 5xx |
| `routingPrompt` | `true` | publish the tool-choice table |

`0` is meaningful for every budget/retry knob and disables that limit.

</details>

### Making enrichment land reliably

An enrichment scrape can take 6–33 s. `dsh-tool-web` defaults `searchTimeoutMs` to 30 s and kills
the call past it, so the plugin's `searchBudgetMs` stays under that and *skips* the upgrade rather
than starting one it cannot finish (an aborted scrape is still billed). To get enrichment every
time, raise both sides:

```yaml
- id: tool-web
  config:
    searchTimeoutMs: 60000
- id: web-firecrawl
  config:
    searchBudgetMs: 50000
    enrichTimeoutMs: 45000
```

## Fleet deployment

One command per person, and bundle registration is automatic:

```sh
dsh plugin --profile web add dsh-web-firecrawl                            # from npm
dsh plugin --profile web add git+ssh://git@host/org/repo.git#v0.1.0       # from git
dsh plugin --profile web add /srv/pkgs/dsh-web-firecrawl                  # from a shared directory
dsh plugin --profile web remove dsh-web-firecrawl                         # rollback
```

The endpoint is deployment-wide, so hand it out through the environment
(`FIRECRAWL_BASE_URL` in a project `.env`) rather than through per-user patches.

Health check across a fleet:

```sh
dsh --profile web --dump-config | grep -A3 '^- id: web$'
```

## Troubleshooting

| symptom | cause |
|---|---|
| `web_search` returns results from another backend | the bundle is not mounted: check `searchProvider` in `--dump-config` |
| `skipping profile bundle` at boot | a denied bundle is still listed in `dsh.profile.bundles`; remove it |
| `patch: entry "…" not found` | a stale patch entry targets an id that no longer exists |
| every call is slow | `enrichTopK` is upgrading results (see the timeout section above) |
| `budget … exhausted` | a cap fired; on a self-hosted instance set `billingMode: unmetered` |

## Publishing (maintainers)

The package is published to **registry.npmjs.org** — not GitHub Packages. GitHub's npm registry
requires an access token to *install* even public packages
([docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry):
"You need an access token to publish, install, and delete private, internal, and public packages"),
which would turn a one-command install into account + PAT + `~/.npmrc` setup for every user.

Releases go through `.github/workflows/publish.yml` on a `v*` tag, using npm **trusted publishing**
(OIDC) — no long-lived token, provenance attached automatically. Two one-time steps:

1. The **first** version must be published outside CI (`npm publish` with an OTP). npm has no
   equivalent of PyPI's "pending publisher": configuring trust for a package that does not exist yet
   fails with `404 Package not found` from `POST /-/package/<name>/trust`.
2. Then bind the repository to the package. Either the website
   (package → Settings → Trusted Publisher → GitHub Actions) or, scriptable:

   ```sh
   npm trust github <package> --file publish.yml --repository <owner>/<repo> --allow-publish
   ```

   **`--allow-publish` is not optional.** Trusted-publisher configurations created after
   2026-09-03 default to **`npm stage publish` only**; without explicitly allowing direct
   publishing, a tag-triggered `npm publish` is rejected. The website equivalent is the
   "Allow npm publish" checkbox on the Trusted Publisher form.

   Both `--file` (workflow file name, including the extension) and `--repository` (which must match
   `repository.url` in package.json) are validated **only at publish time** — npm does not verify
   them when you save, so a typo surfaces later as `ENEEDAUTH`.
   The CLI command needs npm ≥ 11.15.0.

   Then optionally: Settings → Publishing access → *Require two-factor authentication and disallow
   tokens* (trusted publishers keep working — they use OIDC, not tokens).

After that, a release is:

```sh
npm version patch        # or minor / major
git push --follow-tags   # CI publishes on the v* tag
```

## Tests

```sh
npm test              # stub-based suites, no network
npm run test:live     # against a real endpoint: FIRECRAWL_TEST_BASE_URL=...
npm run test:seam     # against real dsh packages: DSH_PACKAGES_DIR=...
```

## Compatibility

No `@deepseek-ai/*` imports and no `@deepseek-ai/*` peer dependencies, on purpose. The only
contract is the web seam itself:

```js
{ id, available(), search(request, signal) }   // -> { sources[], content?, truncated }
{ id, available(), fetch(request, signal) }    // -> { url, statusCode, body, truncated }
```

## License

MIT
