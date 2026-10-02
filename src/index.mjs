/**
 * Firecrawl for the DSH web seam (`ctx.web`) — smart providers + a tool-layer router.
 *
 * WHY THIS FILE EXISTS
 * `@firecrawl/dsh-firecrawl@0.1.0` pins `@deepseek-ai/dsh-web@0.1.0-rc.6`, so DSH
 * 0.2.0's compatibility preflight denies the whole bundle. This file replaces it
 * and goes further than the official providers did.
 *
 * It has two halves, deliberately in ONE file so they share state (credit
 * accounting and failure memory):
 *
 *   1. PROVIDERS (ctx.web) — id `firecrawl` for both search and fetch.
 *      - free filters first: query intent → `categories`, `site:` → `includeDomains`,
 *        `limit` rounded up to the next 10-result band (same credits, more recall);
 *      - on-demand upgrade of the top-K results via `/v2/scrape` (`summary` is
 *        +1 credit/result and 4–7x the information of a bare `description`);
 *        `answer` → seam `content`, `summary`/`markdown` → that source's `snippet`,
 *        which is exactly what the official providers threw away;
 *      - the seam gives us only (query, maxResults) / (url), so every routing
 *        decision is inferred from that text;
 *      - in-process caches: a repeated query or URL costs 0 credits;
 *      - credit accounting from the response's own `creditsUsed`, not an estimate.
 *
 *   2. ROUTER (tools waterfall + system prompt) — the part a provider cannot do:
 *      - `tools/pre-execute` denies a repeat of a URL that already failed in a
 *        NON-recoverable way, so "change the source" is enforced rather than
 *        suggested; a hard credit budget stops runaway loops;
 *      - a system-prompt section says which of the eleven MCP tools to reach for.
 *
 * RETRY POLICY (the interesting part)
 * Retrying only helps when the SAME request could succeed later. So:
 *   transport wobble / 429 / 5xx  → backoff and retry (bounded);
 *   out of credits / auth / our own bad arguments → never retry, say why;
 *   target unreachable / 404 / paywall / empty page → never retry the same URL;
 *     these are handed back to the model with an instruction to change the source.
 * See `firecrawl-routing-design.md` §6 for the measured evidence behind each row.
 *
 * ZERO `@deepseek-ai/*` imports and no package.json of its own, so the
 * compatibility preflight (which only reads a plugin's `peerDependencies`) has
 * nothing to deny and this survives dsh upgrades.
 *
 * INSTALL
 *
 *   dsh plugin --profile web add dsh-web-firecrawl
 *
 * That runs pnpm inside the profile and registers this package in
 * `dsh.profile.bundles`; this package's own cordis.patch.yml then selects
 * Firecrawl as the provider and mounts the plugin. Restart dsh afterwards —
 * profile config is composed at boot.
 *
 * Point it at your endpoint through the environment (project `.env` or the
 * launching environment), not through a per-user patch:
 *
 *   FIRECRAWL_BASE_URL=https://firecrawl.example.com   # self-hosted, no key needed
 *   FIRECRAWL_API_KEY=fc-...                           # only for api.firecrawl.dev
 */

/** Both capabilities register under this id; keep it in sync with `- id: web`. */
const PROVIDER_ID = 'firecrawl'

const DEFAULTS = {
  baseURL: 'https://api.firecrawl.dev',
  /** Firecrawl-side budget for one request; self-hosted scrape can take ~26s to fail. */
  timeoutMs: 60_000,
  /**
   * Wall-clock budget for one whole `search()` call, enrichment included.
   * `dsh-tool-web` defaults `searchTimeoutMs` to 30s and kills the call past it,
   * so the default here stays comfortably under that. Raise it together with
   * `- id: tool-web config: searchTimeoutMs` if you want upgrades to always land.
   */
  searchBudgetMs: 25_000,
  /** Cap for one enrichment scrape (never let an upgrade blow the whole search budget). */
  enrichTimeoutMs: 20_000,
  /** Skip the upgrade entirely when less than this remains of `searchBudgetMs`. */
  enrichMinRemainingMs: 8_000,

  // ── search ────────────────────────────────────────────────────────────────
  /** Infer `categories` from the query. Free on the instance; big precision win. */
  inferCategories: true,
  /** Turn `site:`/`-site:` into includeDomains/excludeDomains and strip it. */
  parseSiteOperators: true,
  /** Upgrade the top-K results with a real scrape. 0 disables (cheapest). */
  enrichTopK: 1,
  /** `summary` (+1 credit, 4–7x info) | `markdown` (+1) | `question` (+4, real answer). */
  enrichFormat: 'summary',
  /** Question text for `enrichFormat: 'question'`. */
  enrichQuestion: 'Answer the user question using only this page, in under 120 words.',
  /** `adaptive` upgrades only when the bare snippets look thin; `always` never skips. */
  enrichMode: 'adaptive',
  /** Snippet shorter than this (characters) counts as "thin" for adaptive mode. */
  thinSnippetChars: 160,
  /** Hard cap on a snippet handed to the model. */
  maxSnippetChars: 1_400,

  // ── fetch ────────────────────────────────────────────────────────────────
  onlyMainContent: true,
  blockAds: true,
  /** Firecrawl cache window; speeds things up (it does NOT reduce credits). */
  maxAgeMs: 172_800_000,
  /** Extra wait before snapshotting, for JS-heavy pages. */
  waitForMs: 0,
  /** Used by the one allowed route change when a JS shell is detected. */
  shellWaitForMs: 2_500,
  maxBodyChars: 100_000,
  /** PDF parsing bills 1 credit PER PAGE — this cap is what stops a 300-page bill. */
  pdfMaxPages: 20,

  // ── shared ───────────────────────────────────────────────────────────────
  /** In-process cache for repeated queries/URLs: the only thing that truly saves credits. */
  cacheTtlMs: 600_000,
  /** How long a non-recoverable failure is remembered (router denies repeats).
   *  600000 = 10 min; 0 = memory off (every repeat is allowed); negative = until restart. */
  failureTtlMs: 600_000,
  /**
   * Whether this backend actually bills.
   *
   *   'auto'      probe once (see `detectBilling`) and cache the verdict;
   *   'metered'   always enforce the credit caps;
   *   'unmetered' never enforce them.
   *
   * A self-hosted Firecrawl short-circuits billing (`USE_DB_AUTHENTICATION=false`)
   * yet still reports `creditsUsed`, so counting works there but CAPPING on it
   * would throttle a free instance. Set 'unmetered' explicitly when you know your
   * deployment instead of trusting the probe.
   */
  billingMode: 'auto',
  /** Firecrawl-side budget for the probe request. */
  billingProbeTimeoutMs: 5_000,
  /** How long a probed verdict is trusted before it is re-checked. */
  billingProbeTtlMs: 600_000,
  /** Rolling CREDIT budget — enforced only when metered; 0 disables. */
  budgetWindowMs: 600_000,
  budgetWindowCredits: 60,
  budgetSessionCredits: 300,
  /**
   * Stop when the backend's own reported balance drops below this (metered only;
   * 0 disables). Useful behind a rotating paid proxy, where the balance is real
   * money and a runaway loop spends it. The reading refreshes with the billing
   * probe (every `billingProbeTtlMs`), so treat it as a coarse floor, not a meter.
   */
  minRemainingCredits: 0,
  /** Rolling CALL budget — always enforced (runaway-loop guard, not billing); 0 disables. */
  budgetWindowCalls: 120,
  retryTransport: 2,
  retryRateLimit: 2,
  retryServer: 1,
  /** Publish the tool-choice table in the system prompt. */
  routingPrompt: true,
}

// ────────────────────────────────────────────────────────────────────────────
// small utilities
// ────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Positive integer from config, else the default. */
function intOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** Non-negative integer from config, else the default. */
function uintOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function trimBase(baseURL) {
  return String(baseURL).replace(/\/+$/, '')
}

function truncate(text, max) {
  return typeof text === 'string' && text.length > max ? text.slice(0, max) : text
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Human-readable age of a remembered verdict, e.g. "2 min ago". */
function ageLabel(at) {
  const seconds = Math.max(1, Math.round((Date.now() - at) / 1_000))
  if (seconds < 90) return `${seconds}s ago`
  return `${Math.round(seconds / 60)} min ago`
}

/**
 * Resolve a launch-time environment value the way DSH does: the launcher's
 * snapshot first (it can carry layers that never touched `process.env` — a
 * project `.env`, the desktop launcher, an SSH-scoped layer), then the inherited
 * environment. Read through the context slot on purpose: importing
 * `@deepseek-ai/dsh-launch-environment` would give this plugin dsh peer
 * dependencies and hand the compatibility preflight something to deny.
 */
function launchValue(ctx, name) {
  try {
    const found = ctx.get?.('launchEnvironment')?.get?.(name)
    if (typeof found?.value === 'string' && found.value.length > 0) return found.value
  } catch {
    // Fall through to the inherited environment.
  }
  return process.env[name]
}

// ────────────────────────────────────────────────────────────────────────────
// shared runtime state (one process, both halves of this plugin)
// ────────────────────────────────────────────────────────────────────────────

const state = {
  /** key → { at, value } for successful search/fetch results. */
  cache: new Map(),
  /** key → { at, kind, hint } for NON-recoverable failures only. */
  failures: new Map(),
  /** [timestampMs, credits] pairs, pruned to the budget window. */
  spend: [],
  /** timestamps of every provider request actually sent (retries included). */
  calls: [],
  sessionCredits: 0,
  /** Cached result of the billing probe: { mode, at }. */
  billing: { mode: undefined, at: 0 },
  /** Last balance reported by a metered backend: { value, at }. */
  remainingCredits: undefined,
  /** Warn sink supplied by the host at apply() time. */
  logger: undefined,
  /** One-shot guard so a fallback warning is printed once, not per call. */
  warnedPublicFallback: false,
  /** Set when Firecrawl answers 402: every later call is refused until restart. */
  paused: undefined,
}

function cacheGet(key, ttlMs) {
  const hit = state.cache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > ttlMs) {
    state.cache.delete(key)
    return undefined
  }
  return hit.value
}

function cacheSet(key, value, limit = 256) {
  state.cache.set(key, { at: Date.now(), value })
  // Cheap bound: a session should not grow this without limit.
  while (state.cache.size > limit) state.cache.delete(state.cache.keys().next().value)
}

function rememberFailure(key, kind, hint, ttlMs) {
  state.failures.set(key, { at: Date.now(), kind, hint })
  if (state.failures.size > 256) state.failures.delete(state.failures.keys().next().value)
}

function lookupFailure(key, ttlMs) {
  const hit = state.failures.get(key)
  if (hit === undefined) return undefined
  // ttlMs < 0 means "remember for the life of this process"; 0 disables the
  // memory entirely (the entry can never be observed again).
  if (ttlMs >= 0 && Date.now() - hit.at > ttlMs) {
    state.failures.delete(key)
    return undefined
  }
  return hit
}

function charge(credits) {
  if (!Number.isFinite(credits) || credits <= 0) return
  state.spend.push([Date.now(), credits])
  state.sessionCredits += credits
}

/** Record one provider request actually put on the wire (retries included). */
function chargeCall() {
  state.calls.push(Date.now())
}

function windowCredits(windowMs) {
  const cutoff = Date.now() - windowMs
  state.spend = state.spend.filter(([at]) => at >= cutoff)
  return state.spend.reduce((sum, [, credits]) => sum + credits, 0)
}

function windowCalls(windowMs) {
  const cutoff = Date.now() - windowMs
  state.calls = state.calls.filter((at) => at >= cutoff)
  return state.calls.length
}

/**
 * Decide whether this deployment actually bills, once per probe TTL.
 *
 * The signal is `GET /v2/team/credit-usage`, measured on both kinds of backend:
 *   cloud / paid proxy → 200 with real balance data, and a bad key is refused;
 *   self-hosted        → 500 `UNKNOWN_ERROR` (route exists but there is no team
 *                        to bill), and even a bogus key is accepted.
 * Anything inconclusive stays 'metered': silently dropping the money guard on a
 * transient probe failure would be the expensive direction to be wrong in.
 *
 * @returns 'metered' | 'unmetered'
 */
async function detectBilling(options) {
  const { baseURL, apiKey, cfg } = options
  const configured = cfg.billingMode ?? DEFAULTS.billingMode
  if (configured === 'metered' || configured === 'unmetered') return configured
  // uintOr: 0 is meaningful here (re-probe on every call), unlike most knobs.
  const ttl = uintOr(cfg.billingProbeTtlMs, DEFAULTS.billingProbeTtlMs)
  if (state.billing.mode !== undefined && Date.now() - state.billing.at < ttl) return state.billing.mode

  let verdict = 'metered'
  try {
    const response = await fetch(`${baseURL}/v2/team/credit-usage`, {
      headers: { ...authHeader(apiKey), accept: 'application/json' },
      signal: AbortSignal.timeout(intOr(cfg.billingProbeTimeoutMs, DEFAULTS.billingProbeTimeoutMs)),
    })
    const text = await response.text()
    if (response.status === 404) verdict = 'unmetered'
    else if (response.status === 401 || response.status === 403) verdict = 'metered'
    else if (response.status === 200) verdict = 'metered'
    else if (/UNKNOWN_ERROR/.test(text)) verdict = 'unmetered'
    // A metered endpoint may also tell us the actual balance; keep the latest.
    try {
      const remaining = JSON.parse(text)?.data?.remainingCredits
      if (Number.isFinite(remaining)) state.remainingCredits = { value: remaining, at: Date.now() }
    } catch {
      // Balance is a bonus, never a requirement.
    }
  } catch {
    verdict = 'metered'
  }
  state.billing = { mode: verdict, at: Date.now() }
  // Safety net for fleet deployments: cordis patches REPLACE a config object
  // rather than merging it, so a per-user `config:` on this entry silently drops
  // a shipped baseURL. Landing on the public metered API that way costs real
  // money, so say it out loud once instead of failing silently.
  if (verdict === 'metered' && baseURL === trimBase(DEFAULTS.baseURL) && state.warnedPublicFallback !== true) {
    state.warnedPublicFallback = true
    state.logger?.warn?.(
      `web-firecrawl: using the PUBLIC metered Firecrawl API (${DEFAULTS.baseURL}). ` +
      'If this deployment was meant to point at a private/self-hosted endpoint, a profile patch most likely ' +
      'replaced the web-firecrawl config object (cordis patches replace, they do not merge) — set baseURL again or use FIRECRAWL_BASE_URL.',
    )
  }
  return verdict
}

/**
 * Auth header for one provider request.
 *
 * A keyless deployment is legitimate: a rotating proxy in front of the paid API
 * injects credentials upstream, and a self-hosted instance checks nothing. Sending
 * `Bearer ` (empty) to such a proxy is worse than sending nothing, so the header
 * is omitted entirely when no key is configured.
 */
function authHeader(apiKey) {
  return apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}
}

/**
 * Whether the configured budget currently forbids another provider call.
 *
 * @param cfg - plugin config.
 * @param billingMode - 'metered' | 'unmetered' from {@link detectBilling}.
 */
function budgetReason(cfg, billingMode) {
  if (state.paused !== undefined) return state.paused
  const windowMs = intOr(cfg.budgetWindowMs, DEFAULTS.budgetWindowMs)
  const windowMinutes = Math.round(windowMs / 60_000)

  if (billingMode === 'metered') {
    const floor = uintOr(cfg.minRemainingCredits, DEFAULTS.minRemainingCredits)
    if (floor > 0 && state.remainingCredits !== undefined && state.remainingCredits.value < floor) {
      return `[firecrawl] Metered backend reports only ${state.remainingCredits.value} credits left (floor ${floor}). Stop spending: tell the user, and only continue with their explicit go-ahead.`
    }
    const windowCap = uintOr(cfg.budgetWindowCredits, DEFAULTS.budgetWindowCredits)
    if (windowCap > 0) {
      const spent = windowCredits(windowMs)
      if (spent >= windowCap) {
        return `[firecrawl] Metered backend: web budget for the last ${windowMinutes} min is exhausted (${spent}/${windowCap} credits). Continuing would keep billing; use mcp__firecrawl__firecrawl_map / _crawl / _parse for targeted work, or raise budgetWindowCredits in the plugin config.`
      }
    }
    const sessionCap = uintOr(cfg.budgetSessionCredits, DEFAULTS.budgetSessionCredits)
    if (sessionCap > 0 && state.sessionCredits >= sessionCap) {
      return `[firecrawl] Metered backend: session web budget is exhausted (${state.sessionCredits}/${sessionCap} credits). Stop and confirm with the user before spending more.`
    }
  }

  // Volume guard applies either way: a free backend can still be hammered by a loop,
  // and every call costs latency and context even when it costs no money.
  const callCap = uintOr(cfg.budgetWindowCalls, DEFAULTS.budgetWindowCalls)
  if (callCap > 0) {
    const calls = windowCalls(windowMs)
    if (calls >= callCap) {
      const billing = billingMode === 'metered' ? 'metered' : 'self-hosted/unmetered'
      return `[firecrawl] ${billing} backend: ${calls} web calls in the last ${windowMinutes} min (cap ${callCap}). That usually means a loop, not a hard question — narrow the question, reuse a URL you already fetched, or raise budgetWindowCalls (0 disables this guard).`
    }
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// failure taxonomy (see firecrawl-routing-design.md §6 — every row is measured)
// ────────────────────────────────────────────────────────────────────────────

/** Pull the engine list out of Firecrawl's SCRAPE_ALL_ENGINES_FAILED message. */
function enginesTried(text) {
  const match = /Engines tried:\s*\[([^\]]*)\]/.exec(text)
  return match === null ? undefined : match[1].trim()
}

/**
 * Classify one Firecrawl response.
 *
 * The subtle rows, both measured on the self-hosted instance:
 *  - `SCRAPE_ALL_ENGINES_FAILED` is used BOTH for "the target site is
 *    unreachable" (`Engines tried: [playwright, fetch]`) and for "we passed an
 *    unsupported parameter" (`Engines tried: []`). Retrying the second one is
 *    pure waste, so the message text, not the code, decides.
 *  - A 404 target is NOT an error: Firecrawl answers HTTP 200 + success with the
 *    site's own 404 page, detectable only through `metadata.statusCode`.
 */
function classifyHttp(status, payload) {
  const text = String(payload?.error ?? '')
  if (status === 429) {
    return { kind: 'rate-limit', recoverable: true, hint: 'provider rate limit (HTTP 429).' }
  }
  if (status === 402) {
    return { kind: 'payment', recoverable: false, hint: 'provider account is out of credits (HTTP 402).' }
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      recoverable: false,
      hint: `provider refused the request (HTTP ${status}): ${truncate(text, 200)}. That is a configuration or entitlement issue, not a site problem.`,
    }
  }
  if (status === 400 || status === 422 || payload?.code === 'BAD_REQUEST') {
    return {
      kind: 'bad-request',
      recoverable: false,
      hint: `provider rejected the request as invalid (HTTP ${status}): ${truncate(text, 200)}. That is a client-side bug, not a site problem.`,
    }
  }
  if (status >= 500) {
    const engines = enginesTried(text)
    if (payload?.code === 'SCRAPE_ALL_ENGINES_FAILED' && engines !== undefined && engines.length === 0) {
      return {
        kind: 'unsupported',
        recoverable: false,
        hint: `provider could not run this request at all (${truncate(text, 160)}). The parameters are unsupported here, not the site.`,
      }
    }
    if (payload?.code === 'SCRAPE_ALL_ENGINES_FAILED') {
      return {
        kind: 'blocked',
        recoverable: false,
        hint: 'the target site returned nothing to any engine (unreachable, bot-blocked, or requiring authentication).',
      }
    }
    return { kind: 'server', recoverable: true, hint: `provider failure (HTTP ${status}).` }
  }
  return { kind: 'unknown', recoverable: false, hint: `unexpected provider failure (HTTP ${status}): ${truncate(text, 160)}` }
}

// ────────────────────────────────────────────────────────────────────────────
// transport
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST one Firecrawl operation, retrying only the recoverable classes.
 *
 * @returns the parsed envelope (`success !== false`).
 * @throws an Error whose message tells the model what to do next.
 */
async function postFirecrawl(path, body, label, options) {
  const { baseURL, apiKey, timeoutMs, signal, cfg } = options
  const endpoint = `${baseURL}${path}`
  let attempt = 0

  for (;;) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    chargeCall()
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        // A credentialed request must never follow a redirect to another origin.
        redirect: 'error',
        headers: {
          ...authHeader(apiKey),
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'dsh-web-firecrawl/2.0',
        },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted === true) throw new Error(`[firecrawl] ${label} cancelled.`, { cause: error })
      // OUR OWN timeout is not a network wobble: retrying it just bills again,
      // and a self-hosted scrape can spend ~26s failing on its own.
      if (timeout.aborted === true) {
        const shown = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
        throw new Error(`[firecrawl] ${label} exceeded its ${shown} budget. Firecrawl may still be working on it (and may still bill), so this is not retried — narrow the request, or raise the timeout in the plugin config.`, { cause: error })
      }
      const transport = {
        kind: 'transport',
        recoverable: true,
        hint: `transport error (${message(error)}) — a network wobble rather than the site.`,
      }
      const cap = uintOr(cfg.retryTransport, DEFAULTS.retryTransport)
      if (attempt >= cap) {
        throw new Error(`[firecrawl] ${label} failed after ${attempt + 1} attempts: ${transport.hint} Try a different source, or check that ${baseURL} is reachable.`, { cause: error })
      }
      attempt += 1
      await sleep(500 * 3 ** (attempt - 1) + Math.random() * 250)
      continue
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      const cap = uintOr(cfg.retryServer, DEFAULTS.retryServer)
      if (attempt >= cap) {
        throw new Error(`[firecrawl] ${label} returned an unparsable body (HTTP ${response.status}) after ${attempt + 1} attempts.`, { cause: error })
      }
      attempt += 1
      await sleep(500 * 3 ** (attempt - 1))
      continue
    }

    if (response.ok && payload?.success !== false) return payload

    const failure = classifyHttp(response.status, payload)

    if (failure.kind === 'payment') {
      state.paused = '[firecrawl] Provider is out of credits (HTTP 402); web search/fetch is paused until credits are restored.'
      throw new Error(`[firecrawl] ${label} failed: ${failure.hint} Do not keep calling web tools — tell the user.`)
    }
    if (!failure.recoverable) {
      throw new Error(`[firecrawl] ${label} failed: ${failure.hint}`)
    }

    const cap = failure.kind === 'rate-limit'
      ? uintOr(cfg.retryRateLimit, DEFAULTS.retryRateLimit)
      : uintOr(cfg.retryServer, DEFAULTS.retryServer)
    if (attempt >= cap) {
      throw new Error(`[firecrawl] ${label} failed after ${attempt + 1} attempts: ${failure.hint} Retrying more will not help — use a different route or source.`)
    }
    attempt += 1
    const retryAfter = Number(response.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 10_000)
      : 500 * 3 ** (attempt - 1) + Math.random() * 250
    await sleep(wait)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// search: intent inference, mapping, on-demand upgrade
// ────────────────────────────────────────────────────────────────────────────

/** Free precision: route the query to a Firecrawl category channel. */
function inferCategories(query, cfg) {
  if (cfg.inferCategories === false) return []
  const text = query.toLowerCase()
  if (/(arxiv|preprint|\bpaper\b|\bpapers\b|study|survey|论文|文献|研究)/.test(text)) return ['research']
  if (/(github|gitlab|\brepo\b|repository|source code|\bsdk\b|api reference|\bnpm\b|pypi|源码|仓库|代码)/.test(text)) return ['developer']
  if (/(whitepaper|white paper|specification|\brfc\b|\bpdf\b|datasheet|白皮书|规范|手册)/.test(text)) return ['pdf']
  return []
}

/** `site:a.com` / `-site:b.com` are hard filters in the API but weak text in a search engine. */
function parseSiteOperators(query, cfg) {
  if (cfg.parseSiteOperators === false) return { query, includeDomains: [], excludeDomains: [] }
  const includeDomains = []
  const excludeDomains = []
  const host = (spec) => spec.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim()
  const stripped = query
    .replace(/(^|\s)-site:(\S+)/gi, (_m, _lead, spec) => {
      excludeDomains.push(host(spec))
      return ' '
    })
    .replace(/(^|\s)site:(\S+)/gi, (_m, _lead, spec) => {
      includeDomains.push(host(spec))
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return {
    query: stripped.length === 0 ? query : stripped,
    includeDomains: includeDomains.filter((value) => value.length > 0),
    excludeDomains: excludeDomains.filter((value) => value.length > 0),
  }
}

/** Search bills 2 credits per 10 results: round UP so extra recall is free. */
function bandLimit(maxResults) {
  return Math.max(10, Math.ceil(intOr(maxResults, 10) / 10) * 10)
}

function mapSources(payload, maxSnippetChars) {
  const data = payload?.data ?? {}
  const entries = [...(Array.isArray(data.web) ? data.web : []), ...(Array.isArray(data.news) ? data.news : [])]
  const seen = new Set()
  const sources = []
  for (const entry of entries) {
    const url = typeof entry?.url === 'string' ? entry.url : ''
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const snippet = [entry.description, entry.snippet, entry.summary]
      .find((value) => typeof value === 'string' && value.length > 0)
    const publishedAt = [entry.date, entry.publishedDate].find((value) => typeof value === 'string' && value.length > 0)
    sources.push({
      url,
      ...(typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {}),
      ...(snippet === undefined ? {} : { snippet: truncate(snippet, maxSnippetChars) }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/** Adaptive mode: only pay for an upgrade when the free snippets are visibly thin. */
function shouldEnrich(sources, cfg) {
  if (cfg.enrichMode === 'always') return true
  const top = sources[0]
  if (top === undefined) return false
  const threshold = intOr(cfg.thinSnippetChars, DEFAULTS.thinSnippetChars)
  return (top.snippet ?? '').length < threshold || sources.length < 3
}

/** One targeted scrape — the "second stage" that replaces blanket `scrapeOptions`. */
async function enrichSource(url, cfg, options) {
  const format = cfg.enrichFormat ?? DEFAULTS.enrichFormat
  const formats = format === 'question'
    ? [{ type: 'question', question: String(cfg.enrichQuestion ?? DEFAULTS.enrichQuestion) }]
    : [format === 'markdown' ? 'markdown' : 'summary']
  const payload = await postFirecrawl(
    '/v2/scrape',
    {
      url,
      formats,
      onlyMainContent: cfg.onlyMainContent !== false,
      maxAge: uintOr(cfg.maxAgeMs, DEFAULTS.maxAgeMs),
      parsers: [{ type: 'pdf', mode: 'fast', maxPages: intOr(cfg.pdfMaxPages, DEFAULTS.pdfMaxPages) }],
    },
    'Firecrawl enrich',
    options,
  )
  charge(payload?.data?.metadata?.creditsUsed)
  const data = payload?.data ?? {}
  return {
    answer: typeof data.answer === 'string' ? data.answer : undefined,
    text: [data.summary, data.markdown].find((value) => typeof value === 'string' && value.length > 0),
    status: data?.metadata?.statusCode,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// fetch: URL-type routing and "arrived but useless" classification
// ────────────────────────────────────────────────────────────────────────────

const JS_SHELL = /enable javascript|just a moment|checking your browser|cf-browser-verification|cf_chl|attention required/i
const PAYWALL = /subscribe to (read|continue)|sign in to (read|continue)|create a free account|already a subscriber|premium content/i

function classifyDocument(data) {
  const status = data?.metadata?.statusCode
  if (status === 404 || status === 410) {
    return { kind: 'not-found', recoverable: false, hint: `the site reports HTTP ${status} for this URL.` }
  }
  const text = [data?.markdown, data?.summary].find((value) => typeof value === 'string') ?? ''
  const trimmed = text.trim()
  if (JS_SHELL.test(trimmed) && trimmed.length < 4_000) {
    return { kind: 'js-shell', recoverable: false, hint: 'the page is a JavaScript shell or anti-bot interstitial rather than content.' }
  }
  if (trimmed.length < 400 && PAYWALL.test(trimmed)) {
    return { kind: 'paywall', recoverable: false, hint: 'the page is behind a login or paywall.' }
  }
  if (trimmed.length < 120) {
    return { kind: 'empty', recoverable: false, hint: `the page returned almost no readable content (${trimmed.length} characters).` }
  }
  return undefined
}

function scrapeBody(url, cfg, extra = {}) {
  const waitFor = uintOr(cfg.waitForMs, DEFAULTS.waitForMs)
  return {
    url,
    formats: ['markdown'],
    onlyMainContent: cfg.onlyMainContent !== false,
    blockAds: cfg.blockAds !== false,
    maxAge: uintOr(cfg.maxAgeMs, DEFAULTS.maxAgeMs),
    // Cap PDF pages on EVERY request: an uncapped 300-page PDF bills 300 credits.
    parsers: [{ type: 'pdf', mode: 'fast', maxPages: intOr(cfg.pdfMaxPages, DEFAULTS.pdfMaxPages) }],
    // `extra` wins so the one JS-shell route change can raise this per attempt.
    ...(waitFor > 0 ? { waitFor } : {}),
    ...extra,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// cordis plugin
// ────────────────────────────────────────────────────────────────────────────

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-firecrawl'

/** The web seam must exist before we can register providers into it. */
export const inject = ['web']

const ROUTING_PROMPT = `## Choosing a web tool

- web_search is the cheap discovery default (2 credits per 10 results). Put related
  queries in one call instead of issuing several.
- web_fetch reads one URL you already have.
- Before crawling a site, list its pages with mcp__firecrawl__firecrawl_map (flat 1 credit).
- mcp__firecrawl__firecrawl_crawl bills per page: always pass an explicit limit.
- For structured fields or an answer from a single page, prefer
  mcp__firecrawl__firecrawl_scrape with a json or question format over guessing from snippets.
- Code and repository questions: mcp__firecrawl__firecrawl_developer_search.
- Documents and local files: mcp__firecrawl__firecrawl_parse.
- Papers: mcp__firecrawl__firecrawl_research_search_papers, then _read_paper, then _related_papers.
- A page that returns no content is a dead end: change the source or the keywords.
  Re-fetching the same URL is denied and still costs credits.`

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  // The launch environment wins over the config default, matching how DSH itself
  // treats env overrides for the seam ($DSH_WEB_SEARCH_PROVIDER does the same).
  // It also keeps deployment-wide values out of `config`, because cordis patches
  // REPLACE a config object rather than merging it — a per-user patch that sets
  // only `apiKey` would otherwise wipe the shipped baseURL and silently fall back
  // to the public cloud API.
  const apiKey = String(launchValue(ctx, 'FIRECRAWL_API_KEY') ?? cfg.apiKey ?? '')
  const rawBaseURL = String(launchValue(ctx, 'FIRECRAWL_BASE_URL') ?? cfg.baseURL ?? DEFAULTS.baseURL)
  const baseURL = trimBase(rawBaseURL)
  const timeoutMs = intOr(cfg.timeoutMs, DEFAULTS.timeoutMs)
  const cacheTtlMs = uintOr(cfg.cacheTtlMs, DEFAULTS.cacheTtlMs)
  // Signed on purpose: 0 disables the memory, a negative value never expires.
  const failureTtlMs = Number.isInteger(cfg.failureTtlMs) ? cfg.failureTtlMs : DEFAULTS.failureTtlMs
  const maxSnippetChars = intOr(cfg.maxSnippetChars, DEFAULTS.maxSnippetChars)
  const maxBodyChars = intOr(cfg.maxBodyChars, DEFAULTS.maxBodyChars)

  // A keyless deployment is fine when the endpoint was chosen explicitly (env or
  // config): a rotating proxy or self-hosted instance needs no client credential.
  // With no key AND the default public origin we stay unavailable — that is the
  // "you forgot to configure anything" case, and failing loudly beats 401 loops.
  const explicitBaseURL = rawBaseURL !== DEFAULTS.baseURL
  state.logger = ctx.logger
  const usable = () => URL.canParse(rawBaseURL) && timeoutMs > 0 && (apiKey.length > 0 || explicitBaseURL)
  const options = { baseURL, apiKey, timeoutMs, cfg }

  /** Resolve the billing verdict, then refuse the call if any budget is spent. */
  const guard = async () => {
    const reason = budgetReason(cfg, await detectBilling(options))
    if (reason !== undefined) throw new Error(reason)
  }

  // ── search provider ──────────────────────────────────────────────────────
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: usable,
    async search(request, signal) {
      await guard()
      const startedAt = Date.now()
      const planned = parseSiteOperators(request.query, cfg)
      const categories = inferCategories(planned.query, cfg)
      const maxResults = intOr(request.maxResults, 10)
      const cacheKey = JSON.stringify(['search', planned.query, categories, planned.includeDomains, planned.excludeDomains])
      const cached = cacheGet(cacheKey, cacheTtlMs)
      if (cached !== undefined) return { ...cached, sources: cached.sources.slice(0, maxResults) }

      const payload = await postFirecrawl(
        '/v2/search',
        {
          query: planned.query,
          limit: bandLimit(maxResults),
          sources: ['web'],
          ...(categories.length > 0 ? { categories } : {}),
          ...(planned.includeDomains.length > 0 ? { includeDomains: planned.includeDomains } : {}),
          ...(planned.excludeDomains.length > 0 ? { excludeDomains: planned.excludeDomains } : {}),
        },
        'Firecrawl search',
        { ...options, signal },
      )
      charge(payload?.creditsUsed)

      const sources = mapSources(payload, maxSnippetChars)
      if (sources.length === 0) {
        return {
          sources: [],
          truncated: false,
          content: '[firecrawl] No sources matched. Rephrase the query or drop restrictive filters — repeating it returns nothing again and still costs credits.',
        }
      }

      let content
      const upgradeK = uintOr(cfg.enrichTopK, DEFAULTS.enrichTopK)
      if (upgradeK > 0 && shouldEnrich(sources, cfg)) {
        const budgetMs = intOr(cfg.searchBudgetMs, DEFAULTS.searchBudgetMs)
        const minRemaining = intOr(cfg.enrichMinRemainingMs, DEFAULTS.enrichMinRemainingMs)
        const enrichCap = intOr(cfg.enrichTimeoutMs, DEFAULTS.enrichTimeoutMs)
        const answers = []
        for (const source of sources.slice(0, upgradeK)) {
          // Aborting an upgrade mid-flight still bills it, so skip instead of
          // starting one that cannot finish inside this call's budget.
          const remaining = startedAt + budgetMs - Date.now() - 2_000
          if (remaining < minRemaining) break
          try {
            const enriched = await enrichSource(source.url, cfg, {
              ...options,
              signal,
              timeoutMs: Math.min(enrichCap, remaining),
            })
            if (enriched.status === 404 || enriched.status === 410) continue
            if (enriched.answer !== undefined) {
              answers.push(enriched.answer)
              source.snippet = truncate(enriched.answer, maxSnippetChars)
            } else if (enriched.text !== undefined) {
              source.snippet = truncate(enriched.text, maxSnippetChars)
            }
          } catch {
            // An upgrade failure must never fail the search itself.
          }
        }
        if (answers.length > 0) content = answers.join('\n\n')
      }

      const result = { sources, truncated: false, ...(content === undefined ? {} : { content }) }
      // Always cached, answer included: the TTL is short and a repeated identical
      // query must not re-bill just because the first answer was enriched.
      cacheSet(cacheKey, result)
      return { ...result, sources: sources.slice(0, maxResults) }
    },
  })

  // ── fetch provider ───────────────────────────────────────────────────────
  ctx.web.registerFetchProvider({
    id: PROVIDER_ID,
    available: usable,
    async fetch(request, signal) {
      await guard()
      const url = request.url
      const memoryKey = `fetch:${url}`
      const remembered = lookupFailure(memoryKey, failureTtlMs)
      if (remembered !== undefined) {
        throw new Error(`[firecrawl] Not fetching ${url} again: ${remembered.hint} (judged ${ageLabel(remembered.at)}.) Change the source or the keywords instead.`)
      }
      const cached = cacheGet(memoryKey, cacheTtlMs)
      if (cached !== undefined) return cached

      const payload = await postFirecrawl('/v2/scrape', scrapeBody(url, cfg), 'Firecrawl fetch', { ...options, signal })
      charge(payload?.data?.metadata?.creditsUsed)

      let data = payload?.data ?? {}
      let failure = classifyDocument(data)

      // Exactly one "change the route, not the request" retry: a JS shell often
      // renders if we simply give the page time.
      if (failure?.kind === 'js-shell') {
        const waitFor = intOr(cfg.shellWaitForMs, DEFAULTS.shellWaitForMs)
        try {
          const retry = await postFirecrawl('/v2/scrape', scrapeBody(url, cfg, { waitFor }), 'Firecrawl fetch (render retry)', { ...options, signal })
          charge(retry?.data?.metadata?.creditsUsed)
          const retryData = retry?.data ?? {}
          if (classifyDocument(retryData) === undefined) {
            data = retryData
            failure = undefined
          }
        } catch {
          // Keep the original diagnosis when the render retry itself fails.
        }
      }

      if (failure !== undefined) {
        if (failureTtlMs !== 0) rememberFailure(memoryKey, failure.kind, failure.hint, failureTtlMs)
        throw new Error(`[firecrawl] ${url}: ${failure.hint} Retrying this URL will not help — change the source or the keywords.`)
      }

      const raw = typeof data.markdown === 'string' ? data.markdown : (typeof data.summary === 'string' ? data.summary : '')
      const content = truncate(raw, maxBodyChars)
      const result = {
        url: typeof data?.metadata?.sourceURL === 'string' && data.metadata.sourceURL.length > 0 ? data.metadata.sourceURL : url,
        statusCode: Number.isInteger(data?.metadata?.statusCode) ? data.metadata.statusCode : 200,
        // The seam's body union is closed: html | text. Markdown rides the text arm.
        body: { kind: 'text', content },
        truncated: content.length < raw.length,
      }
      cacheSet(memoryKey, result)
      return result
    },
  })

  // ── router: the half a provider cannot do ────────────────────────────────
  ctx.inject(['tools'], (inner) => {
    inner.on('tools/pre-execute', async (exec, next) => {
      const args = exec.arguments ?? {}
      if (exec.name === 'web_search' || exec.name === 'web_fetch') {
        const reason = budgetReason(cfg, await detectBilling(options))
        if (reason !== undefined) return { kind: 'deny', reason }
      }
      if (exec.name === 'web_fetch' && typeof args.url === 'string') {
        // Non-recoverable failures only: a network blip never blocks a retry.
        const remembered = lookupFailure(`fetch:${args.url}`, failureTtlMs)
        if (remembered !== undefined) {
          return {
            kind: 'deny',
            reason: `[firecrawl] ${args.url} was already judged unusable ${ageLabel(remembered.at)} (${remembered.hint}). Do not repeat it: change the keywords or the source, or use mcp__firecrawl__firecrawl_map / _crawl to find other pages.`,
          }
        }
      }
      return next()
    })
  })

  ctx.inject(['systemPrompt'], (inner) => {
    if (cfg.routingPrompt === false) return
    inner.systemPrompt.section({
      name: 'firecrawl:web-routing',
      order: inner.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + 50,
      text: ROUTING_PROMPT,
    })
  })
}
