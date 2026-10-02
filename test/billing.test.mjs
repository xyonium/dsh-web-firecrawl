const FILE = new URL('../src/index.mjs', import.meta.url).href
let seq = 0
const fresh = () => import(`${FILE}?v=${++seq}`)
const realFetch = globalThis.fetch
const calls = []

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) }
}
function stub(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push(path)
    return handler(path, init)
  }
}
async function mount(config = {}) {
  const mod = await fresh()
  const reg = {}
  const hooks = {}
  mod.apply({
    web: { registerSearchProvider: (p) => { reg.search = p }, registerFetchProvider: (p) => { reg.fetch = p } },
    inject: (deps, cb) => cb({ on: (e, h) => { hooks[e] = h }, systemPrompt: { section: () => {}, getSectionOrder: () => 2100 } }),
  }, { baseURL: 'https://fc.test', apiKey: 'k', ...config })
  return { reg, hooks }
}
const results = []
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`) }
const searchOk = { success: true, creditsUsed: 2, data: { web: [{ url: 'https://x.example/1', title: 'T', description: 'd'.repeat(400) }] } }

// ── A. 探测 = 500 UNKNOWN_ERROR（自建）→ unmetered，额度上限不生效 ────────
{
  const { reg } = await mount({ budgetWindowCredits: 1, enrichTopK: 0 })
  stub((path) => path === '/v2/team/credit-usage'
    ? fakeResponse(500, { success: false, code: 'UNKNOWN_ERROR', error: 'An error occurred.' })
    : fakeResponse(200, searchOk))
  const r1 = await reg.search.search({ query: 'a', maxResults: 3 })
  const r2 = await reg.search.search({ query: 'b', maxResults: 3 })
  check('自建 → 额度上限不再拦截', r1.sources.length === 1 && r2.sources.length === 1, `probe=${calls.filter((p) => p === '/v2/team/credit-usage').length} 次`)
  check('探测只做一次（缓存判定）', calls.filter((p) => p === '/v2/team/credit-usage').length === 1, calls.join(','))
}

// ── B. 探测 = 200（云端）→ metered，额度上限照常生效 ─────────────────────
{
  const { reg } = await mount({ budgetWindowCredits: 1, enrichTopK: 0 })
  stub((path) => path === '/v2/team/credit-usage'
    ? fakeResponse(200, { success: true, data: { remainingCredits: 999 } })
    : fakeResponse(200, searchOk))
  await reg.search.search({ query: 'a', maxResults: 3 })
  let err = ''
  try { await reg.search.search({ query: 'b', maxResults: 3 }) } catch (e) { err = e.message }
  check('云端 → 额度上限生效', /Metered backend.*exhausted/.test(err), err.slice(0, 60))
}

// ── C. 探测 404 → unmetered；探测异常 → 保守按 metered ──────────────────
{
  const { reg } = await mount({ budgetWindowCredits: 1, enrichTopK: 0 })
  stub((path) => path === '/v2/team/credit-usage' ? fakeResponse(404, { code: 'NOT_FOUND' }) : fakeResponse(200, searchOk))
  await reg.search.search({ query: 'a', maxResults: 3 })
  let ok404 = true
  try { await reg.search.search({ query: 'b', maxResults: 3 }) } catch { ok404 = false }
  check('探测 404 → unmetered', ok404)

  const { reg: reg2 } = await mount({ budgetWindowCredits: 1, enrichTopK: 0 })
  stub((path) => {
    if (path === '/v2/team/credit-usage') throw new Error('ECONNREFUSED')
    return fakeResponse(200, searchOk)
  })
  await reg2.search.search({ query: 'a', maxResults: 3 })
  let err = ''
  try { await reg2.search.search({ query: 'b', maxResults: 3 }) } catch (e) { err = e.message }
  check('探测失败 → 保守按 metered（不放开钱袋）', /Metered backend/.test(err), err.slice(0, 50))
}

// ── D. 显式 billingMode 'unmetered' 跳过探测 ────────────────────────────
{
  const { reg } = await mount({ billingMode: 'unmetered', budgetWindowCredits: 1, enrichTopK: 0 })
  stub(() => fakeResponse(200, searchOk))
  await reg.search.search({ query: 'a', maxResults: 3 })
  await reg.search.search({ query: 'b', maxResults: 3 })
  check("显式 'unmetered' → 完全不探测", calls.filter((p) => p === '/v2/team/credit-usage').length === 0, calls.join(','))
}

// ── E. 调用上限在两种模式下都生效 ──────────────────────────────────────
{
  const { reg, hooks } = await mount({ billingMode: 'unmetered', enrichTopK: 0, budgetWindowCalls: 2 })
  stub(() => fakeResponse(200, searchOk))
  await reg.search.search({ query: 'a', maxResults: 3 })
  await reg.search.search({ query: 'b', maxResults: 3 })
  let err = ''
  try { await reg.search.search({ query: 'c', maxResults: 3 }) } catch (e) { err = e.message }
  check('自建上调用上限仍生效（防跑飞）', /self-hosted\/unmetered backend: 2 web calls/.test(err), err.slice(0, 70))
  const denied = await hooks['tools/pre-execute']({ name: 'web_search', arguments: { queries: ['x'] } }, async () => ({ kind: 'allow' }))
  check('pre-execute 同样按新规则 deny', denied.kind === 'deny' && /web calls/.test(denied.reason))
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
