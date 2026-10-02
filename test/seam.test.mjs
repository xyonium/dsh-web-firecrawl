// 用真实的 cordis Context + 真实的 WebRuntime 服务（不是桩）验证 seam 层集成
const ROOT = process.env.DSH_PACKAGES_DIR
if (ROOT === undefined || ROOT.length === 0) {
  console.log('SKIP  set DSH_PACKAGES_DIR to the @deepseek-ai directory of a dsh installation to run the seam suite.')
  console.log('      e.g. DSH_PACKAGES_DIR=$(dirname $(dirname $(command -v dsh)))/node_modules/@deepseek-ai')
  process.exit(0)
}
const { Context } = await import(`${ROOT}/cordis/lib/index.js`)
const WebRuntime = (await import(`${ROOT}/dsh-web/lib/index.js`)).default
const mod = await import(new URL('../src/index.mjs', import.meta.url).href + '?v=seam1')

const results = []
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`) }

// 1. 按 profile 里的实际配置装配：seam 显式选中 firecrawl
const ctx = new Context()
const web = new WebRuntime(ctx, { searchProvider: 'firecrawl', fetchProvider: 'firecrawl' })
mod.apply(ctx, { baseURL: process.env.FIRECRAWL_TEST_BASE_URL ?? 'https://api.firecrawl.dev', apiKey: process.env.FIRECRAWL_TEST_API_KEY ?? '' })

const r = await web.search({ query: 'kubernetes gateway api vs ingress', maxResults: 3 })
check('seam.search() 走通 provider', Array.isArray(r.sources) && r.sources.length > 0, `${r.sources.length} 条`)
check('seam 按 maxResults 截断', r.sources.length <= 3, `${r.sources.length} <= 3`)
check('结果是归一化形状（url + 可选 title/snippet）',
  r.sources.every((s) => typeof s.url === 'string' && s.url.startsWith('http')), JSON.stringify(r.sources[0]).slice(0, 120))

const f = await web.fetch({ url: 'https://example.com' })
check('seam.fetch() 走通 provider', f.statusCode === 200 && f.body.kind === 'text' && f.body.content.length > 100, `${f.body.content.length} 字符`)

// 2. 选择语义：id 配错时必须显式报错，而不是另一个 provider 顶上
const ctx2 = new Context()
const web2 = new WebRuntime(ctx2, { searchProvider: 'not-registered' })
mod.apply(ctx2, { baseURL: process.env.FIRECRAWL_TEST_BASE_URL ?? 'https://api.firecrawl.dev', apiKey: process.env.FIRECRAWL_TEST_API_KEY ?? '' })
let code = ''
try { await web2.search({ query: 'x', maxResults: 1 }) } catch (e) { code = e.code ?? e.message }
check('provider id 配错 → 明确报错（不静默选取）', /WEB_PROVIDER_CONFIGURED_MISSING|not registered|missing/i.test(code), String(code).slice(0, 60))

// 3. available() 语义：无 key + 公网默认地址 = "忘了配置" → seam 视为不可用
const ctx3 = new Context()
const web3 = new WebRuntime(ctx3, { searchProvider: 'firecrawl' })
mod.apply(ctx3, { baseURL: undefined, apiKey: '' })   // 不给 baseURL → 落到公网默认
let code3 = ''
try { await web3.search({ query: 'x', maxResults: 1 }) } catch (e) { code3 = e.code ?? e.message }
check('无 key + 公网默认 → seam 判定不可用', /UNAVAILABLE|unavailable/i.test(code3), String(code3).slice(0, 60))

// 4. 无 key + 显式私有端点（无 key 代理形态）→ 可用且真能搜
const ctx4 = new Context()
const web4 = new WebRuntime(ctx4, { searchProvider: 'firecrawl' })
mod.apply(ctx4, { baseURL: process.env.FIRECRAWL_TEST_BASE_URL ?? 'https://api.firecrawl.dev', apiKey: '' })
const keyless = await web4.search({ query: 'clickhouse ttl basic example', maxResults: 2 })
check('无 key + 私有端点 → 可用并可搜（真实调用）', keyless.sources.length > 0, `${keyless.sources.length} 条`)

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
