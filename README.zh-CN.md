# dsh-web-firecrawl

**把 Firecrawl 接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 web 后端。**
它不新增任何工具 —— 模型照旧调 `web_search` / `web_fetch`，由本插件决定怎么问 Firecrawl。

```sh
dsh plugin --profile web add dsh-web-firecrawl
```

## 为什么需要它

官方 [`@firecrawl/dsh-firecrawl`](https://github.com/firecrawl/dsh-firecrawl) 把 peer 钉死在
`@deepseek-ai/dsh-web@0.1.0-rc.6`。DSH 0.2.0 起新增了兼容性闸门：只要插件的
`@deepseek-ai/dsh*` peer 不匹配运行时版本，**整包被跳过**，它自带的 patch 层被丢弃，
`web_search` 就静默回落到别的后端。

本包**不声明任何 `@deepseek-ai/*` peer 依赖**（代码也零 import），而闸门只读 `peerDependencies`
—— 没有东西可拒，所以 dsh 升级后它依然能用。

而且它不只是把 query 转发了事：

| | 官方 0.1.0 | 本包 |
|---|---|---|
| dsh 0.2.x 能否加载 | ❌ 被闸门拒绝 | ✅ 零 dsh peer |
| `categories`（research / developer / pdf） | ❌ 参数面里没有 | ✅ 按 query 意图自动选，**免费** |
| `site:` / `-site:` | ❌ 当普通文本传下去 | ✅ 转成硬过滤 `includeDomains` / `excludeDomains` |
| 结果信息量 | 只取 `description`（~200 字符） | ✅ 只对 top-K 定点升级 `summary`（+1 credit，4–7 倍文本）；`question` 拿生成式答案填进 seam 的 `content` |
| 重复 query / URL | 每次都重新计费 | ✅ 进程内缓存，10 分钟内 0 请求 |
| 死路 URL | 模型会反复重试 | ✅ 失败记忆直接拒绝重抓 |
| 额度安全 | 无 | ✅ 按真实 `creditsUsed` 记账，自动区分计费 / 自建 |
| 工具路由 | 无 | ✅ 系统提示里带一张「何时用哪个 Firecrawl MCP 工具」的表 |

## 安装

```sh
dsh plugin --profile web add dsh-web-firecrawl
```

`dsh plugin` 会在 profile 里跑 pnpm，并**自动**把本包登记进 `dsh.profile.bundles`。
之后**重启 dsh**（profile 在启动时组合）。

端点通过环境变量给（项目 `.env` 或启动环境）：

```sh
# 自建 Firecrawl —— 不需要任何 key
FIRECRAWL_BASE_URL=https://firecrawl.example.com

# 或者公网 API
FIRECRAWL_API_KEY=fc-your-key
```

验证：

```sh
dsh --profile web --dump-config | grep -A3 '^- id: web$'
# 期望：searchProvider: firecrawl / fetchProvider: firecrawl
```

> **不设 `FIRECRAWL_BASE_URL`** 就会指向**公网计费**的 `https://api.firecrawl.dev`。
> 插件会探测出来、启用额度上限并打一条警告 —— 但那已经是可能花钱之后了。请显式设置端点。

### 为什么端点不写进包里的配置

cordis patch 的 `config` 是**整体替换**（`target[key] = value`），不是按键合并。
如果包里发布了 `baseURL`，任何人在自己那层写 `config:` 都会把它静默抹掉、回落到公网计费 API。
所以端点和凭据一律走环境变量（DSH 通过 launch environment 快照解析）。

## 一次查询发生了什么

1. **先做免费的过滤**：意图 → `categories`（research / developer / pdf）；`site:` / `-site:`
   → `includeDomains` / `excludeDomains` 并从 query 剥离；`limit` 向上取整到 10 的倍数
   （搜索按 2 credits / 10 条计费，同一档内多要几条是免费的）。
2. **按需定点升级，而不是整批抓**：`scrapeOptions` 是**按结果条数**计费的，全抓很浪费。
   插件只抓 top-K（`enrichTopK`，默认 1），且只在免费片段看起来太薄时才抓（`enrichMode: adaptive`）。
   `summary` 花 +1 credit 换 4–7 倍文本；`question` 花 +4 拿生成式答案。
3. **额度守卫贴合实际**：用 `/v2/team/credit-usage` 判断这个后端到底计不计费 —— 公网和代付费代理会返回
   余额数据；自建实例返回 `500 UNKNOWN_ERROR`，甚至连假 key 都接受。计费后端启用额度上限，
   自建只用调用量的防跑飞上限。
4. **失败记忆**：站点不可达、404、付费墙、空页会被记住，重复抓取直接拒绝并提示换来源；
   网络抖动 / 429 / 5xx **从不入记忆** —— 那些重试是有意义的。

## 配置

全部可选，写在 profile 的 `cordis.patch.yml` 里。注意 **`config:` 会整体替换**，
所以要保留的键都得重写一遍：

```yaml
- id: web-firecrawl
  config:
    enrichTopK: 1              # 升级前 K 条；0 = 只裸搜（最省）
    enrichFormat: summary      # summary(+1) | markdown(+1) | question(+4)
    enrichMode: adaptive       # 或 always
    budgetWindowCredits: 60    # 仅计费后端：每 10 分钟额度
    budgetWindowCalls: 120     # 两种后端都生效：防跑飞
    minRemainingCredits: 0     # 仅计费后端：余额低于此值停手
    failureTtlMs: 600000       # 失败记忆 TTL；0 = 关闭，负数 = 直到重启
    billingMode: auto          # auto | metered | unmetered
    routingPrompt: true        # 在系统提示里发布工具选择表
```

完整的 33 个参数见英文 README 的 “All options” 折叠表。

### 让升级稳定落地

一次 summary 抓取可能要 6–33 秒，而 `dsh-tool-web` 的 `searchTimeoutMs` 默认 30 秒就会掐断整次调用。
所以插件的 `searchBudgetMs` 压在 30 秒以下，并且**宁可跳过升级也不中途 abort**（abort 照样计费）。
想每次都拿到升级结果，两边一起调：

```yaml
- id: tool-web
  config:
    searchTimeoutMs: 60000
- id: web-firecrawl
  config:
    searchBudgetMs: 50000
    enrichTimeoutMs: 45000
```

## 车队部署

每人一条命令，bundles 自动登记：

```sh
dsh plugin --profile web add dsh-web-firecrawl                          # npm
dsh plugin --profile web add git+ssh://git@host/org/repo.git#v0.1.0     # git tag
dsh plugin --profile web add /srv/pkgs/dsh-web-firecrawl                # 共享目录
dsh plugin --profile web remove dsh-web-firecrawl                       # 回滚
```

端点是部署级的，统一通过环境变量（项目 `.env` 里的 `FIRECRAWL_BASE_URL`）下发，不要走个人 patch。

车队体检：

```sh
dsh --profile web --dump-config | grep -A3 '^- id: web$'
```

## 测试

```sh
npm test              # 打桩套件，不联网
npm run test:live     # 打真实端点：FIRECRAWL_TEST_BASE_URL=...
npm run test:seam     # 打真实 dsh 包：DSH_PACKAGES_DIR=...
```

## 兼容性

刻意不 import 任何 `@deepseek-ai/*`、也不声明它们的 peer。唯一契约就是 web seam 本身：

```js
{ id, available(), search(request, signal) }   // -> { sources[], content?, truncated }
{ id, available(), fetch(request, signal) }    // -> { url, statusCode, body, truncated }
```

## 许可

MIT
