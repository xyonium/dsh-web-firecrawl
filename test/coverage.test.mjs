// 覆盖审计补测：把此前没测到的参数与分支全部压一遍
const FILE = new URL('../src/index.mjs', import.meta.url).href
let seq = 0
const fresh = () => import(`${FILE}?v=${++seq}`)
const calls = []
let probes = 0
let handler = () => { throw new Error('no handler') }
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname
  if (path === '/v2/team/credit-usage') { probes += 1; return resp(200, { success: true, data: { remainingCredits: 1 } }) }
  const body = init.body === undefined ? undefined : JSON.parse(init.body)
  calls.push({ path, body })
  return handler(path, body, calls.length)
}
const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? (resp.retryAfter ?? null) : null) },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => { if (typeof body === 'string') throw new Error('not json'); return body },
})
const ok = (data, extra = {}) => resp(200, { success: true, ...extra, data })
const webDoc = (markdown, metadata = {}) => ok({ markdown, metadata: { statusCode: 200, creditsUsed: 1, sourceURL: 'https://s.example/final', ...metadata } })
const searchOk = (web, extra = {}) => resp(200, { success: true, creditsUsed: 2, ...extra, data: { web } })

async function mount(config = {}) {
  const mod = await fresh()
  const reg = {}; const hooks = {}; let section
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: (p) => { reg.fetch = p } },
    inject: (deps, cb) => cb({ on: (e, h) => { hooks[e] = h }, systemPrompt: { section: (s) => { section = s }, getSectionOrder: () => 2100 } }),
  }, { baseURL: 'https://fc.test', apiKey: 'k', enrichTopK: 0, ...config })
  return { reg, hooks, getSection: () => section }
}
const results = []
const check = (l, okk, d = '') => { results.push(okk); console.log(`${okk ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`) }
const reset = () => { calls.length = 0; probes = 0; handler = () => { throw new Error('no handler') } }

// 1. HTTP 分类：400 / 403 不重试；5xx 重试后成功
{
  reset(); const { reg } = await mount()
  handler = () => resp(400, { success: false, code: 'BAD_REQUEST', error: 'Bad Request', details: [{ path: ['url'] }] })
  let e1 = ''; try { await reg.fetch.fetch({ url: 'https://a.example/1' }) } catch (e) { e1 = e.message }
  check('400 → bad-request，不重试', calls.length === 1 && /client-side bug/.test(e1), `req=${calls.length}`)

  reset()
  handler = () => resp(403, { success: false, error: 'ZDR is not enabled for your team' })
  let e2 = ''; try { await reg.fetch.fetch({ url: 'https://a.example/2' }) } catch (e) { e2 = e.message }
  check('403 → auth，不重试', calls.length === 1 && /entitlement/.test(e2), `req=${calls.length}`)

  reset()
  let n = 0
  handler = () => (++n === 1 ? resp(503, { success: false, error: 'upstream down' }) : webDoc('content '.repeat(40)))
  const r = await reg.fetch.fetch({ url: 'https://a.example/3' })
  check('5xx → 重试后成功', calls.length === 2 && r.body.content.length > 100, `req=${calls.length}`)
}

// 2. 响应体不可解析 → 走 server 重试；429 遵守 Retry-After
{
  reset(); const { reg } = await mount({ retryServer: 1 })
  let n = 0
  handler = () => (++n === 1 ? resp(200, 'not json at all') : webDoc('body '.repeat(60)))
  const r = await reg.fetch.fetch({ url: 'https://b.example/1' })
  check('不可解析响应 → 重试', calls.length === 2 && r.body.content.length > 100, `req=${calls.length}`)

  reset(); const { reg: reg2 } = await mount({ retryRateLimit: 1 })
  resp.retryAfter = '1'
  const t0 = Date.now()
  handler = () => resp(429, { success: false, error: 'rate limited' })
  try { await reg2.search.search({ query: 'rate limited query' }) } catch {}
  resp.retryAfter = null
  check('429 遵守 Retry-After（≥1s 退避）', Date.now() - t0 >= 1000 && calls.length === 2, `${Date.now() - t0}ms, req=${calls.length}`)
}

// 3. 文档分类：付费墙 / 真空页 / JS 空壳（换轨道后成功）
{
  reset(); const { reg } = await mount()
  handler = () => webDoc('Please subscribe to read the full article. Sign in to continue.')
  let e = ''; try { await reg.fetch.fetch({ url: 'https://c.example/paywall' }) } catch (err) { e = err.message }
  check('付费墙 → paywall，不重试', calls.length === 1 && /paywall/.test(e), `req=${calls.length}`)

  reset()
  handler = () => webDoc('tiny')
  let e2 = ''; try { await reg.fetch.fetch({ url: 'https://c.example/empty' }) } catch (err) { e2 = err.message }
  check('极短正文 → empty，不重试', calls.length === 1 && /almost no readable content/.test(e2), `req=${calls.length}`)

  reset()
  let n = 0
  handler = () => (++n === 1 ? webDoc('Just a moment... enable JavaScript and cookies to continue') : webDoc('# Real article\n\n' + 'body '.repeat(60)))
  const r = await reg.fetch.fetch({ url: 'https://c.example/shell' })
  check('JS 空壳 → 换轨道重试成功', calls.length === 2 && /Real article/.test(r.body.content), `req=${calls.length}`)
  check('换轨道那次带了 waitFor', calls[1].body.waitFor === 2500, JSON.stringify(calls[1].body.waitFor))
}

// 4. enrichFormat：markdown（无 answer）与 question（有 answer → seam content）
{
  reset(); const { reg } = await mount({ enrichTopK: 1, enrichMode: 'always', enrichFormat: 'markdown' })
  handler = (path) => (path === '/v2/search'
    ? searchOk([{ url: 'https://d.example/1', title: 'T', description: 'short' }])
    : ok({ markdown: 'M'.repeat(500), metadata: { statusCode: 200, creditsUsed: 1 } }))
  const r = await reg.search.search({ query: 'markdown enrich', maxResults: 3 })
  check('enrichFormat=markdown → 只改 snippet，无 content', r.content === undefined && r.sources[0].snippet.length === 500, `content=${r.content}`)
  check('markdown 抓取请求体正确', calls[1].body.formats[0] === 'markdown')

  reset(); const { reg: reg2 } = await mount({ enrichTopK: 1, enrichMode: 'always', enrichFormat: 'question', enrichQuestion: 'Q?' })
  handler = (path) => (path === '/v2/search'
    ? searchOk([{ url: 'https://d.example/2', title: 'T', description: 'short' }])
    : ok({ answer: 'The answer is 42.', metadata: { statusCode: 200, creditsUsed: 5 } }))
  const r2 = await reg2.search.search({ query: 'question enrich', maxResults: 3 })
  check('enrichFormat=question → answer 进 content', r2.content === 'The answer is 42.', JSON.stringify(r2.content))
  check('question 抓取请求体带题目', calls[1].body.formats[0].type === 'question' && calls[1].body.formats[0].question === 'Q?')
}

// 5. 截断与抓取参数
{
  reset(); const { reg } = await mount({ enrichTopK: 1, enrichMode: 'always', enrichFormat: 'markdown', maxSnippetChars: 120 })
  handler = (path) => (path === '/v2/search'
    ? searchOk([{ url: 'https://e.example/1', title: 'T', description: 'x' }])
    : ok({ markdown: 'Y'.repeat(900), metadata: { statusCode: 200, creditsUsed: 1 } }))
  const r = await reg.search.search({ query: 'truncate snippet', maxResults: 2 })
  check('maxSnippetChars 生效', r.sources[0].snippet.length === 120, `${r.sources[0].snippet.length}`)

  reset(); const { reg: reg2 } = await mount({ maxBodyChars: 100, onlyMainContent: false, blockAds: false, maxAgeMs: 12345, waitForMs: 700, pdfMaxPages: 7 })
  handler = () => webDoc('Z'.repeat(1000))
  const f = await reg2.fetch.fetch({ url: 'https://e.example/big' })
  check('maxBodyChars 截断 + truncated 标记', f.body.content.length === 100 && f.truncated === true, `${f.body.content.length}/${f.truncated}`)
  check('fetch 请求体参数全部透传', calls[0].body.onlyMainContent === false && calls[0].body.blockAds === false && calls[0].body.maxAge === 12345 && calls[0].body.waitFor === 700 && calls[0].body.parsers[0].maxPages === 7, JSON.stringify(calls[0].body).slice(0, 140))
  check('sourceURL / statusCode 映射', f.url === 'https://s.example/final' && f.statusCode === 200, `${f.url} ${f.statusCode}`)
}

// 6. 缓存过期 / 会话额度 / 空结果 / 去重 / 日期 / routingPrompt
{
  reset(); const { reg } = await mount({ cacheTtlMs: 1000 })
  const realNow = Date.now
  handler = () => webDoc('cached body '.repeat(30))
  await reg.fetch.fetch({ url: 'https://f.example/1' })
  Date.now = () => realNow() + 5000
  await reg.fetch.fetch({ url: 'https://f.example/1' })
  Date.now = realNow
  check('cacheTtlMs 到期后重新请求', calls.length === 2, `req=${calls.length}`)

  reset(); const { reg: reg2 } = await mount({ billingMode: 'metered', budgetWindowCredits: 0, budgetSessionCredits: 2 })
  handler = () => searchOk([{ url: 'https://g.example/1', title: 'T', description: 'd'.repeat(400) }])
  await reg2.search.search({ query: 'session one', maxResults: 3 })
  let e = ''; try { await reg2.search.search({ query: 'session two', maxResults: 3 }) } catch (err) { e = err.message }
  check('budgetSessionCredits 生效', /session web budget/.test(e), e.slice(0, 60))

  reset(); const { reg: reg3 } = await mount()
  handler = () => searchOk([])
  const empty = await reg3.search.search({ query: 'nothing matches', maxResults: 3 })
  check('搜索 0 结果 → 给模型改写提示', empty.sources.length === 0 && /Rephrase the query/.test(empty.content ?? ''), (empty.content ?? '').slice(0, 60))

  reset(); const { reg: reg4 } = await mount()
  handler = () => searchOk([
    { url: 'https://h.example/1', title: 'dup', description: 'd'.repeat(400) },
    { url: 'https://h.example/1', title: 'dup again', description: 'd'.repeat(400) },
  ], { data: undefined })
  handler = () => resp(200, { success: true, creditsUsed: 2, data: {
    web: [{ url: 'https://h.example/1', title: 'A', description: 'd'.repeat(400) }, { url: 'https://h.example/1', title: 'A dup', description: 'e'.repeat(400) }],
    news: [{ url: 'https://h.example/news', title: 'N', snippet: 'news body '.repeat(20), date: '2026-09-30' }],
  } })
  const dedup = await reg4.search.search({ query: 'dedup news query', maxResults: 5 })
  check('按 URL 去重 + news 合并 + publishedAt', dedup.sources.length === 2 && dedup.sources[1].publishedAt === '2026-09-30', JSON.stringify(dedup.sources.map((s) => s.url)))

  reset(); const m = await mount({ routingPrompt: false })
  check('routingPrompt=false → 不注册提示段', m.getSection() === undefined)
}

// 7. 升级失败不得拖垮搜索
{
  reset(); const { reg } = await mount({ enrichTopK: 1, enrichMode: 'always', enrichFormat: 'summary' })
  handler = (path) => (path === '/v2/search'
    ? searchOk([{ url: 'https://i.example/1', title: 'T', description: 'thin' }])
    : resp(500, { success: false, code: 'SCRAPE_ALL_ENGINES_FAILED', error: 'engines failed. Engines tried: [playwright]' }))
  const r = await reg.search.search({ query: 'enrich fails', maxResults: 3 })
  check('升级失败 → 搜索仍成功返回', r.sources.length === 1 && r.sources[0].snippet === 'thin', JSON.stringify(r.sources[0].snippet))
}


// 8. 覆盖审计补漏：此前从未被直接配置过的 7 个参数
{
  // inferCategories=false：不再推断 categories
  reset(); const { reg } = await mount({ inferCategories: false })
  handler = () => searchOk([{ url: 'https://j.example/1', title: 'T', description: 'd'.repeat(400) }])
  await reg.search.search({ query: 'arxiv paper on attention', maxResults: 3 })
  check('inferCategories=false → 不带 categories', calls[0].body.categories === undefined, JSON.stringify(calls[0].body.categories))

  // parseSiteOperators=false：site: 留在 query 里
  reset(); const { reg: reg2 } = await mount({ parseSiteOperators: false })
  handler = () => searchOk([{ url: 'https://j.example/2', title: 'T', description: 'd'.repeat(400) }])
  await reg2.search.search({ query: 'ingress site:kubernetes.io', maxResults: 3 })
  check('parseSiteOperators=false → 原样保留', calls[0].body.query === 'ingress site:kubernetes.io' && calls[0].body.includeDomains === undefined, JSON.stringify(calls[0].body.query))

  // thinSnippetChars=500：原本不触发升级的片段现在触发
  reset(); const { reg: reg3 } = await mount({ enrichTopK: 1, thinSnippetChars: 500 })
  handler = (path) => (path === '/v2/search'
    ? searchOk([{ url: 'https://j.example/3', title: 'T', description: 'd'.repeat(400) }, { url: 'https://j.example/4', title: 'T', description: 'd'.repeat(400) }, { url: 'https://j.example/5', title: 'T', description: 'd'.repeat(400) }])
    : ok({ summary: 'S'.repeat(300), metadata: { statusCode: 200, creditsUsed: 1 } }))
  await reg3.search.search({ query: 'threshold probe', maxResults: 5 })
  check('thinSnippetChars=500 → 400 字符片段也算薄，触发升级', calls.filter((c) => c.path === '/v2/scrape').length === 1, `scrape=${calls.filter((c) => c.path === '/v2/scrape').length}`)

  // shellWaitForMs 可配置
  reset(); const { reg: reg4 } = await mount({ shellWaitForMs: 9999 })
  let n = 0
  handler = () => (++n === 1 ? webDoc('Just a moment... enable JavaScript') : webDoc('body '.repeat(60)))
  await reg4.fetch.fetch({ url: 'https://j.example/shell' })
  check('shellWaitForMs 可配置', calls[1].body.waitFor === 9999, String(calls[1].body.waitFor))

  // billingProbeTtlMs=0 → 每次都重新探测
  reset(); const { reg: reg5 } = await mount({ billingProbeTtlMs: 0, enrichTopK: 0 })
  handler = () => searchOk([{ url: 'https://j.example/6', title: 'T', description: 'd'.repeat(400) }])
  await reg5.search.search({ query: 'probe ttl one', maxResults: 3 })
  await reg5.search.search({ query: 'probe ttl two', maxResults: 3 })
  check('billingProbeTtlMs=0 → 每次探测', probes >= 2, `probes=${probes}`)

  // budgetWindowMs 生效：时间往前拨，窗口内的花费应被清掉
  reset(); const { reg: reg6 } = await mount({ billingMode: 'metered', budgetWindowCredits: 2, budgetWindowMs: 60_000 })
  const realNow2 = Date.now
  handler = () => searchOk([{ url: 'https://j.example/7', title: 'T', description: 'd'.repeat(400) }])
  await reg6.search.search({ query: 'window one', maxResults: 3 })
  Date.now = () => realNow2() + 120_000
  let winErr = ''
  try { await reg6.search.search({ query: 'window two', maxResults: 3 }) } catch (e) { winErr = e.message }
  Date.now = realNow2
  check('budgetWindowMs 窗口滑出后可继续', winErr === '', winErr.slice(0, 60))
}


// 9. "0 = 关闭" 语义：重试次数与探测 TTL
{
  reset(); const { reg } = await mount({ retryTransport: 0, timeoutMs: 300 })
  const keepAlive = setInterval(() => {}, 200)
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === '/v2/team/credit-usage') { probes += 1; return resp(200, { success: true, data: {} }) }
    calls.push({ path, body: JSON.parse(init.body) })
    return new Promise((_r, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal.reason)) })
  }
  let e = ''
  try { await reg.search.search({ query: 'retry off' }) } catch (err) { e = err.message }
  clearInterval(keepAlive)
  check('retryTransport=0 → 一次即失败，不重试', calls.length === 1 && /exceeded its/.test(e), `req=${calls.length}`)
}


// 10. API key 解析顺序：config > launch 快照 > process.env
{
  const mod = await fresh()
  const reg = {}
  const launchEnv = { get: (n) => (n === 'FIRECRAWL_API_KEY' ? { value: 'from-launch-snapshot' } : undefined) }
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: () => {} },
    get: (slot) => (slot === 'launchEnvironment' ? launchEnv : undefined),
    inject: () => {},
  }, { baseURL: 'https://fc.test', enrichTopK: 0 })   // 注意：没有 apiKey
  check('无 apiKey 配置时仍可用（走 launch 快照）', reg.search.available() === true)

  const mod2 = await fresh()
  const reg2 = {}
  process.env.FIRECRAWL_API_KEY = 'from-process-env'
  mod2.apply({ web: { registerSearchProvider: (p) => { reg2.search = p }, registerFetchProvider: () => {} }, inject: () => {} },
    { baseURL: 'https://fc.test', enrichTopK: 0 })
  check('launch 快照缺失时回落到 process.env', reg2.search.available() === true)
  delete process.env.FIRECRAWL_API_KEY

  const mod3 = await fresh()
  const reg3 = {}
  mod3.apply({ web: { registerSearchProvider: (p) => { reg3.search = p }, registerFetchProvider: () => {} }, inject: () => {} },
    { baseURL: undefined, enrichTopK: 0 })   // 显式不给 baseURL → 落到公网默认地址
  check('无 key + 公网默认地址 → 判定不可用（不静默失败）', reg3.search.available() === false)
}


// 11. FIRECRAWL_BASE_URL 环境覆盖（部署级值走 env，避免 patch 浅替换陷阱）
{
  const mod = await fresh()
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(new URL(url).origin)
    const path = new URL(url).pathname
    if (path === '/v2/team/credit-usage') return resp(200, { success: true, data: {} })
    return searchOk([{ url: 'https://k.example/1', title: 'T', description: 'd'.repeat(400) }])
  }
  const reg = {}
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: () => {} },
    get: () => ({ get: (n) => (n === 'FIRECRAWL_BASE_URL' ? { value: 'https://env-wins.example' } : undefined) }),
    inject: () => {},
  }, { baseURL: 'https://from-config.example', apiKey: 'k', enrichTopK: 0 })
  await reg.search.search({ query: 'env base url', maxResults: 3 })
  check('FIRECRAWL_BASE_URL 覆盖 config.baseURL', seen.includes('https://env-wins.example'), seen.join(','))
}


// 12. 探测超时（billingProbeTimeoutMs）：不得拖住调用，且保守判为计费
{
  reset()
  const { reg } = await mount({ billingProbeTimeoutMs: 200, budgetWindowCredits: 1, enrichTopK: 0 })
  const keepAlive = setInterval(() => {}, 200)
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === '/v2/team/credit-usage') {
      probes += 1
      // 模拟探测悬挂：只在 signal abort 时 reject，跟真实 fetch 一样
      return new Promise((_r, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal.reason)) })
    }
    calls.push({ path, body: JSON.parse(init.body) })
    return searchOk([{ url: 'https://l.example/1', title: 'T', description: 'd'.repeat(400) }])
  }
  const t0 = Date.now()
  await reg.search.search({ query: 'probe timeout one', maxResults: 3 })
  const elapsed = Date.now() - t0
  let e = ''
  try { await reg.search.search({ query: 'probe timeout two', maxResults: 3 }) } catch (err) { e = err.message }
  clearInterval(keepAlive)
  check('探测超时被自己的 timeout 掐断（不悬挂）', elapsed < 3000 && probes === 1, `${elapsed}ms, probes=${probes}`)
  check('探测判不出来 → 保守按 metered（额度上限仍生效）', /Metered backend/.test(e), e.slice(0, 50))
}


// 13. 无 key 部署（rotator 注入凭据）+ 余额下限守卫
{
  reset()
  const mod = await fresh()
  const reg = {}
  const seenAuth = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    seenAuth.push(init.headers?.authorization ?? '(none)')
    if (path === '/v2/team/credit-usage') return resp(200, { success: true, data: { remainingCredits: 1339 } })
    return searchOk([{ url: 'https://m.example/1', title: 'T', description: 'd'.repeat(400) }])
  }
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: () => {} },
    get: (slot) => (slot === 'launchEnvironment' ? { get: (n) => (n === 'FIRECRAWL_BASE_URL' ? { value: 'https://rotator.example/firecrawl' } : undefined) } : undefined),
    inject: () => {},
  }, { enrichTopK: 0 })            // 注意：既没有 apiKey，也没有 config.baseURL
  check('无 key + 显式 baseURL → 仍可用', reg.search.available() === true)
  await reg.search.search({ query: 'keyless search', maxResults: 3 })
  check('无 key 时不发 Authorization 头', seenAuth.every((h) => h === '(none)'), seenAuth.join(','))

  // 公网默认地址 + 无 key → 仍判不可用（"忘记配置"要显性失败）
  const mod2 = await fresh()
  const reg2 = {}
  mod2.apply({ web: { registerSearchProvider: (p) => { reg2.search = p }, registerFetchProvider: () => {} }, inject: () => {} },
    { enrichTopK: 0 })
  check('无 key + 公网默认 → 判不可用', reg2.search.available() === false)

  // 余额低于下限 → 拦截
  reset()
  const mod3 = await fresh()
  const reg3 = {}
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/v2/team/credit-usage')) return resp(200, { success: true, data: { remainingCredits: 12 } })
    return searchOk([{ url: 'https://m.example/2', title: 'T', description: 'd'.repeat(400) }])
  }
  mod3.apply({ web: { registerSearchProvider: (p) => { reg3.search = p }, registerFetchProvider: () => {} }, inject: () => {} },
    { baseURL: 'https://rotator.example/firecrawl', minRemainingCredits: 200, enrichTopK: 0 })
  let e = ''
  try { await reg3.search.search({ query: 'low balance', maxResults: 3 }) } catch (err) { e = err.message }
  check('余额低于 minRemainingCredits → 拦截', /only 12 credits left/.test(e), e.slice(0, 60))
}


// 14. 公网回落安全网：配置被 patch 覆盖掉时要吼一声
{
  reset()
  const mod = await fresh()
  const reg = {}
  const warnings = []
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/v2/team/credit-usage')) return resp(200, { success: true, data: { remainingCredits: 500 } })
    return searchOk([{ url: 'https://n.example/1', title: 'T', description: 'd'.repeat(400) }])
  }
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: () => {} },
    logger: { warn: (m) => warnings.push(m) },
    inject: () => {},
  }, { enrichTopK: 0 })     // 没有 baseURL → 落到公网默认
  await reg.search.search({ query: 'fallback warn one', maxResults: 3 })
  await reg.search.search({ query: 'fallback warn two', maxResults: 3 })
  check('公网 + 计费 → 告警一次（不刷屏）', warnings.length === 1 && /PUBLIC metered Firecrawl API/.test(warnings[0]), `warnings=${warnings.length}`)

  reset()
  const mod2 = await fresh()
  const reg2 = {}
  const w2 = []
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/v2/team/credit-usage')) return resp(200, { success: true, data: { remainingCredits: 500 } })
    return searchOk([{ url: 'https://n.example/2', title: 'T', description: 'd'.repeat(400) }])
  }
  mod2.apply({
    web: { registerSearchProvider: (p) => { reg2.search = p }, registerFetchProvider: () => {} },
    logger: { warn: (m) => w2.push(m) },
    inject: () => {},
  }, { baseURL: 'https://rotator.example/firecrawl', enrichTopK: 0 })
  await reg2.search.search({ query: 'private endpoint', maxResults: 3 })
  check('私有端点 → 不告警', w2.length === 0, `warnings=${w2.length}`)
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
