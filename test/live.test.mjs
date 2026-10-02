const FILE = new URL('../src/index.mjs', import.meta.url).href
let seq = 0
const fresh = () => import(`${FILE}?v=${++seq}`)
const BASE_URL = process.env.FIRECRAWL_TEST_BASE_URL
if (BASE_URL === undefined || BASE_URL.length === 0) {
  console.log('SKIP  set FIRECRAWL_TEST_BASE_URL (and optionally FIRECRAWL_TEST_API_KEY) to run the live suite against a real Firecrawl.')
  process.exit(0)
}
const realFetch = globalThis.fetch
const log = []
function spy() {
  log.length = 0
  globalThis.fetch = async (url, init) => {
    const t0 = Date.now()
    const probe = new URL(url).pathname === '/v2/team/credit-usage'
    const res = await realFetch(url, init)
    const clone = res.clone()
    let credits, n
    try {
      const j = await clone.json()
      credits = j.creditsUsed ?? j?.data?.metadata?.creditsUsed
      n = j?.data?.web?.length
    } catch {}
    // billing 探测不算 provider 调用
    if (!probe) log.push({ path: new URL(url).pathname, ms: Date.now() - t0, credits, n, body: init?.body ? JSON.parse(init.body) : undefined })
    return res
  }
}

async function mount(config = {}) {
  const mod = await fresh()
  const reg = {}
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: (p) => { reg.fetch = p } },
    inject: () => {},
  }, { baseURL: BASE_URL, apiKey: process.env.FIRECRAWL_TEST_API_KEY ?? '', ...config })
  return reg
}

const results = []
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`) }
const total = () => log.reduce((s, e) => s + (e.credits ?? 0), 0)

// ── 1. 定点升级：自适应跳过 / 安全预算 / 放宽预算 ──────────────────────
{
  const Q = 'clickhouse materialized view refresh strategy'
  spy()
  const base = await mount({ enrichTopK: 0 })
  const t0 = Date.now()
  const bare = await base.search.search({ query: Q, maxResults: 5 })
  const bareMs = Date.now() - t0
  const bareTop = (bare.sources[0]?.snippet ?? '').length
  console.log(`   裸搜            : ${bare.sources.length} 条, top ${bareTop} 字符, ${bareMs}ms, credits=${log.reduce((s,e)=>s+(e.credits??0),0)}`)

  spy()
  const adaptive = await mount({ enrichTopK: 1, enrichFormat: 'summary' })
  await adaptive.search.search({ query: Q, maxResults: 5 })
  console.log(`   默认(adaptive)  : 调用=${log.map(e=>e.path).join(' ')}`)
  check('片段够厚时自适应跳过升级（省钱）', log.filter((e) => e.path === '/v2/scrape').length === 0, `thin=${bareTop < 160}`)

  spy()
  const forced = await mount({ enrichTopK: 1, enrichFormat: 'summary', enrichMode: 'always' })
  const t1 = Date.now()
  const f = await forced.search.search({ query: Q, maxResults: 5 })
  const fMs = Date.now() - t1
  console.log(`   强制+安全(25s)  : top ${(f.sources[0]?.snippet ?? '').length} 字符, ${fMs}ms, 调用=${log.map(e=>e.path+'('+(e.credits ?? '?')+', '+e.ms+'ms)').join(' ')}`)
  check('安全默认下不会拖过 30s 工具超时', fMs < 30_000, `${fMs}ms`)
  check('安全默认下仍返回完整结果数', f.sources.length === 5)

  spy()
  const wide = await mount({ enrichTopK: 1, enrichFormat: 'summary', enrichMode: 'always', searchBudgetMs: 90_000, enrichTimeoutMs: 80_000 })
  const t2 = Date.now()
  const w = await wide.search.search({ query: Q, maxResults: 5 })
  const wMs = Date.now() - t2
  const wTop = (w.sources[0]?.snippet ?? '').length
  console.log(`   强制+放宽(80s)  : top ${wTop} 字符, ${wMs}ms, 调用=${log.map(e=>e.path+'('+(e.credits ?? '?')+', '+e.ms+'ms)').join(' ')}`)
  check('放宽预算后升级落地（snippet 变长 1.5x+）', wTop > bareTop * 1.5, `${bareTop} → ${wTop}`)
  check('升级只多花 1 次 scrape', log.filter((e) => e.path === '/v2/scrape').length === 1)
}

// ── 2. categories 推断真的改变结果集 ───────────────────────────────────
{
  spy()
  const reg = await mount({ enrichTopK: 0 })
  const r = await reg.search.search({ query: 'arxiv paper attention mechanism survey', maxResults: 5 })
  const hosts = r.sources.map((s) => { try { return new URL(s.url).host } catch { return '?' } })
  const researchy = hosts.filter((h) => /arxiv|nature|sciencedirect|springer|acm|ieee|semanticscholar|openreview/.test(h)).length
  console.log('   hosts:', hosts.join(', '))
  check('论文查询命中研究站点', researchy >= 2, `${researchy}/${hosts.length}`)
  check('请求带了 categories', JSON.stringify(log[0].body.categories) === '["research"]')
}

// ── 3. 真实抓取 + 缓存 ────────────────────────────────────────────────
{
  spy()
  const reg = await mount()
  const f1 = await reg.fetch.fetch({ url: 'https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/' })
  const first = log.length
  const f2 = await reg.fetch.fetch({ url: 'https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/' })
  check('抓取返回 markdown 正文', f1.body.content.length > 2000 && f1.statusCode === 200, `${f1.body.content.length} 字符`)
  check('重复抓取命中进程内缓存（0 请求）', log.length === first, `requests=${log.length}`)
  check('两次内容一致', f1.body.content === f2.body.content)
}

// ── 4. 真实 404 页面 → not-found + 失败记忆 ────────────────────────────
{
  spy()
  const reg = await mount()
  let err = ''
  try { await reg.fetch.fetch({ url: 'https://kubernetes.io/docs/definitely-not-a-real-page-xyz' }) } catch (e) { err = e.message }
  const after = log.length
  let err2 = ''
  try { await reg.fetch.fetch({ url: 'https://kubernetes.io/docs/definitely-not-a-real-page-xyz' }) } catch (e) { err2 = e.message }
  check('真实 404 → not-found 判定', /HTTP 404/.test(err), err.slice(0, 70))
  check('失败记忆 → 第二次 0 请求且消息不同', log.length === after && /Not fetching/.test(err2), `requests=${log.length}`)
}

// ── 5. 预算按真实 creditsUsed 记账 ────────────────────────────────────
{
  spy()
  const reg = await mount({ billingMode: 'metered', budgetWindowCredits: 2, enrichTopK: 0 })
  await reg.search.search({ query: 'budget accounting probe one', maxResults: 5 })
  const spentAfterOne = log.reduce((s, e) => s + (e.credits ?? 0), 0)
  let blocked = ''
  try { await reg.search.search({ query: 'budget accounting probe two', maxResults: 5 }) } catch (e) { blocked = e.message }
  check('第一次搜索记到 2+ credits', spentAfterOne >= 2, `credits=${spentAfterOne}`)
  check('显式 metered 下累计达上限被拦', /budget .* exhausted/.test(blocked), blocked.slice(0, 70))
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
