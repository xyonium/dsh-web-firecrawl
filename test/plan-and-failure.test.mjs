const FILE = new URL('../src/index.mjs', import.meta.url).href
let seq = 0
const fresh = () => import(`${FILE}?v=${++seq}`)

function fakeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  }
}

async function mount(config = {}) {
  const mod = await fresh()
  const reg = { search: null, fetch: null }
  const hooks = { pre: null }
  let section = null
  const ctx = {
    web: {
      registerSearchProvider: (p) => { reg.search = p },
      registerFetchProvider: (p) => { reg.fetch = p },
    },
    inject: (deps, cb) => {
      const inner = {
        on: (event, handler) => { if (event === 'tools/pre-execute') hooks.pre = handler },
        systemPrompt: { section: (s) => { section = s }, getSectionOrder: (n) => (n === 'TOOL_WEB_FETCH' ? 2100 : 0) },
      }
      cb(inner)
    },
  }
  mod.apply(ctx, { baseURL: 'https://fc.test', apiKey: 'k', ...config })
  return { mod, reg, hooks, getSection: () => section }
}

const calls = []
function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    // billing 探测不算 provider 调用
    if (path === '/v2/team/credit-usage') return fakeResponse(200, { success: true, data: { remainingCredits: 1 } })
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    calls.push({ path, body })
    return handler(path, body, calls.length)
  }
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// ── A. 搜索规划：site: 解析 + band limit ─────────────────────────────
{
  const { reg } = await mount()
  stubFetch(() => fakeResponse(200, { success: true, creditsUsed: 2, data: { web: [
    { url: 'https://kubernetes.io/docs/a', title: 'A', description: 'x'.repeat(300) },
    { url: 'https://kubernetes.io/docs/b', title: 'B', description: 'y'.repeat(300) },
    { url: 'https://kubernetes.io/docs/c', title: 'C', description: 'z'.repeat(300) },
  ] } }))
  await reg.search.search({ query: 'ingress controller site:kubernetes.io -site:github.com', maxResults: 3 })
  const body = calls[0].body
  check('site: → includeDomains', JSON.stringify(body.includeDomains) === '["kubernetes.io"]', JSON.stringify(body.includeDomains))
  check('-site: → excludeDomains', JSON.stringify(body.excludeDomains) === '["github.com"]', JSON.stringify(body.excludeDomains))
  check('site: 从 query 剥离', body.query === 'ingress controller', JSON.stringify(body.query))
  check('limit 上取整到 10', body.limit === 10, String(body.limit))
  check('maxResults=3 → 返回 3 条', (await reg.search.search({ query: 'ingress controller site:kubernetes.io -site:github.com', maxResults: 3 })).sources.length === 3)
}

// ── B. categories 推断 ──────────────────────────────────────────────
{
  const { reg } = await mount()
  stubFetch(() => fakeResponse(200, { success: true, creditsUsed: 2, data: { web: [{ url: 'https://a.b/c', title: 'T', description: 'd'.repeat(300) }] } }))
  const searchCalls = () => calls.filter((c) => c.path === '/v2/search')
  await reg.search.search({ query: 'arxiv paper on attention', maxResults: 5 })
  check('论文 → research', JSON.stringify(searchCalls()[0].body.categories) === '["research"]', JSON.stringify(searchCalls()[0].body.categories))
  await reg.search.search({ query: 'github repo for a kv store', maxResults: 5 })
  check('代码 → developer', JSON.stringify(searchCalls()[1].body.categories) === '["developer"]', JSON.stringify(searchCalls()[1].body.categories))
  await reg.search.search({ query: 'just some ordinary query', maxResults: 5 })
  check('普通查询不加 categories', searchCalls()[2].body.categories === undefined)
}

// ── C/D. 5xx 的两种语义：目标站挂 vs 我们参数错 ──────────────────────
{
  const { reg } = await mount()
  const enginesFail = (engines) => fakeResponse(500, { success: false, code: 'SCRAPE_ALL_ENGINES_FAILED', error: `All scraping engines failed to retrieve content from this URL. Engines tried: [${engines}]. This usually happens when...` })
  stubFetch(() => enginesFail('playwright, fetch'))
  let err1 = ''
  try { await reg.fetch.fetch({ url: 'https://blocked.example/x' }) } catch (e) { err1 = e.message }
  check('目标站挂 → blocked，且不重试', calls.length === 1 && /bot-blocked|unreachable/.test(err1), `requests=${calls.length}`)
  stubFetch(() => enginesFail(''))
  let err2 = ''
  try { await reg.fetch.fetch({ url: 'https://unsupported.example/x' }) } catch (e) { err2 = e.message }
  check('Engines tried: [] → unsupported（不是 blocked）', calls.length === 1 && /unsupported/.test(err2), `requests=${calls.length} :: ${err2.slice(0, 90)}`)
}

// ── E/F. 429 重试 / 402 熔断 ────────────────────────────────────────
{
  const { reg } = await mount({ retryRateLimit: 2 })
  stubFetch(() => fakeResponse(429, { success: false, error: 'rate limited' }, { 'retry-after': '0' }))
  let err = ''
  try { await reg.search.search({ query: 'q1' }) } catch (e) { err = e.message }
  check('429 → 重试到上限后失败（1+2 次）', calls.length === 3 && /429/.test(err), `requests=${calls.length}`)

  const { reg: reg2 } = await mount()
  stubFetch(() => fakeResponse(402, { success: false, error: 'no credits' }))
  try { await reg2.search.search({ query: 'q2' }) } catch {}
  const after = calls.length
  let err2 = ''
  try { await reg2.search.search({ query: 'q3' }) } catch (e) { err2 = e.message }
  check('402 → 熔断：后续调用 0 请求', after === 1 && calls.length === 1 && /out of credits/.test(err2), `requests=${calls.length}`)
}

// ── G. 目标 404（200 + metadata.statusCode）───────────────────────────
{
  const { reg, hooks } = await mount()
  stubFetch(() => fakeResponse(200, { success: true, data: { markdown: 'Were you looking for:', metadata: { statusCode: 404, creditsUsed: 1 } } }))
  let err = ''
  try { await reg.fetch.fetch({ url: 'https://site.example/gone' }) } catch (e) { err = e.message }
  check('404 文档 → not-found，不重试', calls.length === 1 && /HTTP 404/.test(err), `requests=${calls.length}`)
  const denied = await hooks.pre({ name: 'web_fetch', arguments: { url: 'https://site.example/gone' } }, async () => ({ kind: 'allow' }))
  check('失败记忆 → pre-execute deny', denied.kind === 'deny' && /judged unusable/.test(denied.reason), denied.kind)
  const allowed = await hooks.pre({ name: 'web_fetch', arguments: { url: 'https://site.example/other' } }, async () => ({ kind: 'allow' }))
  check('未失败过的 URL → 放行', allowed.kind === 'allow')
}

// ── H/I. 缓存 ───────────────────────────────────────────────────────
{
  const { reg } = await mount()
  stubFetch(() => fakeResponse(200, { success: true, data: { markdown: 'M'.repeat(500), metadata: { statusCode: 200, creditsUsed: 1, sourceURL: 'https://c.example/p' } } }))
  await reg.fetch.fetch({ url: 'https://c.example/p' })
  await reg.fetch.fetch({ url: 'https://c.example/p' })
  check('fetch 缓存命中 → 只 1 次请求', calls.length === 1, `requests=${calls.length}`)

  const { reg: reg2 } = await mount()
  stubFetch(() => fakeResponse(200, { success: true, creditsUsed: 2, data: { web: [{ url: 'https://d.example/1', title: 'T', description: 'd'.repeat(400) }] } }))
  await reg2.search.search({ query: 'same query', maxResults: 5 })
  const first = calls.filter((c) => c.path === '/v2/search').length
  await reg2.search.search({ query: 'same query', maxResults: 5 })
  const afterSecond = calls.filter((c) => c.path === '/v2/search').length
  check('search 缓存命中 → 第二次 0 请求', first === 1 && afterSecond === 1, `search requests=${afterSecond}`)
}

// ── J. 预算闸门 ─────────────────────────────────────────────────────
{
  const { reg, hooks } = await mount({ budgetWindowCredits: 3 })
  stubFetch(() => fakeResponse(200, { success: true, creditsUsed: 2, data: { web: [{ url: 'https://e.example/1', title: 'T', description: 'd'.repeat(400) }] } }))
  await reg.search.search({ query: 'budget one', maxResults: 5 })
  await reg.search.search({ query: 'budget two', maxResults: 5 })   // 累计 4 >= 3
  let err = ''
  try { await reg.search.search({ query: 'budget three', maxResults: 5 }) } catch (e) { err = e.message }
  check('provider 层预算拦截', /budget .* exhausted/.test(err), err.slice(0, 80))
  const denied = await hooks.pre({ name: 'web_search', arguments: { queries: ['x'] } }, async () => ({ kind: 'allow' }))
  check('pre-execute 预算 deny', denied.kind === 'deny' && /budget/.test(denied.reason))
}

// ── K. 系统提示路由表 ───────────────────────────────────────────────
{
  const m = await mount()
  const section = m.getSection()
  check('注册 routing section', section !== null && section.order === 2150 && /web_search is the cheap discovery default/.test(section.text), `order=${section?.order}`)
  check('路由表提到 11 个 MCP 工具中的关键项', /firecrawl_map/.test(section.text) && /firecrawl_crawl/.test(section.text) && /research_search_papers/.test(section.text))
}


// ── L. 自己的超时不算网络抖动（不得重试）────────────────────────────
{
  const { reg } = await mount({ timeoutMs: 400, retryTransport: 2 })
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === '/v2/team/credit-usage') return fakeResponse(200, { success: true, data: { remainingCredits: 1 } })
    calls.push({ path, body: JSON.parse(init.body) })
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason))
    })
  }
  // AbortSignal.timeout 的定时器在 Node 里是 unref 的：测试里必须自己吊住事件循环
  const keepAlive = setInterval(() => {}, 200)
  let err = ''
  try { await reg.search.search({ query: 'slow query' }) } catch (e) { err = e.message }
  clearInterval(keepAlive)
  check('自身超时 → 不重试（1 次请求）', calls.length === 1 && /exceeded its/.test(err), `requests=${calls.length} :: ${err.slice(0, 70)}`)
}

// ── M. 预算不足以完成升级时，宁可不升级（避免中断计费）──────────────
{
  const { reg } = await mount({ searchBudgetMs: 10000, enrichMinRemainingMs: 9000, enrichTopK: 1 })
  stubFetch(() => fakeResponse(200, { success: true, creditsUsed: 2, data: { web: [
    { url: 'https://f.example/1', title: 'T', description: 'thin' },
  ] } }))
  const r = await reg.search.search({ query: 'thin snippet query', maxResults: 5 })
  check('剩余预算不足 → 跳过升级，只 1 次请求', calls.filter((c) => c.path === '/v2/scrape').length === 0 && r.sources.length === 1, `requests=${calls.map((c) => c.path).join(',')}`)
}


// ── N. 失败记忆的 TTL 语义：正常过期 / 0 关闭 / 负数永不过期 ───────────
{
  const gone = { success: true, data: { markdown: 'x', metadata: { statusCode: 404, creditsUsed: 1 } } }
  const realNow = Date.now

  // (a) TTL=1s，把时间往后拨 5s → 记忆过期，允许重试
  {
    const { reg } = await mount({ failureTtlMs: 1000 })
    stubFetch(() => fakeResponse(200, gone))
    try { await reg.fetch.fetch({ url: 'https://t.example/a' }) } catch {}
    Date.now = () => realNow() + 5000
    try { await reg.fetch.fetch({ url: 'https://t.example/a' }) } catch {}
    Date.now = realNow
    check('TTL 到期后允许重试', calls.length === 2, `requests=${calls.length}`)
  }

  // (b) TTL=0 → 记忆关闭，立刻可重试
  {
    const { reg } = await mount({ failureTtlMs: 0 })
    stubFetch(() => fakeResponse(200, gone))
    try { await reg.fetch.fetch({ url: 'https://t.example/b' }) } catch {}
    try { await reg.fetch.fetch({ url: 'https://t.example/b' }) } catch {}
    check('failureTtlMs=0 → 记忆关闭，可连续重试', calls.length === 2, `requests=${calls.length}`)
  }

  // (c) TTL=-1 → 永不过期（时间往后拨 5 天仍然拦）
  {
    const { reg, hooks } = await mount({ failureTtlMs: -1 })
    stubFetch(() => fakeResponse(200, gone))
    try { await reg.fetch.fetch({ url: 'https://t.example/c' }) } catch {}
    const after = calls.length
    Date.now = () => realNow() + 5 * 24 * 3600 * 1000
    let err = ''
    try { await reg.fetch.fetch({ url: 'https://t.example/c' }) } catch (e) { err = e.message }
    const denied = await hooks.pre({ name: 'web_fetch', arguments: { url: 'https://t.example/c' } }, async () => ({ kind: 'allow' }))
    Date.now = realNow
    check('failureTtlMs=-1 → 5 天后仍然拦截', calls.length === after && /Not fetching/.test(err), `requests=${calls.length}`)
    check('pre-execute 拒绝信息带判定时间', denied.kind === 'deny' && /(s|min) ago/.test(denied.reason), denied.reason.slice(0, 90))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
