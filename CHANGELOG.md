# Changelog

## 0.1.0

First release.

- Firecrawl providers for the DSH web seam (`web_search` / `web_fetch`), registered under the id
  `firecrawl`, with **no `@deepseek-ai/*` peer dependencies** so the DSH 0.2.x compatibility
  preflight has nothing to refuse.
- Query planning: intent → `categories`, `site:` / `-site:` → `includeDomains` / `excludeDomains`,
  `limit` rounded up to the next 10-result billing band.
- On-demand enrichment of the top-K results (`summary` / `markdown` / `question`), adaptive by
  default, with a whole-call budget so the upgrade can never blow the tool timeout.
- In-process cache for repeated queries and URLs, and failure memory for non-recoverable
  failures, enforced through a `tools/pre-execute` gate.
- Failure taxonomy that only retries transport wobble, 429 and 5xx; content-level failures are
  handed back to the model with an instruction to change the source.
- Billing detection (`/v2/team/credit-usage`) separating metered backends (credit caps) from
  self-hosted ones (call-volume guard only), plus an optional `minRemainingCredits` floor and a
  warning when the public metered API is used unintentionally.
- Keyless deployment support (self-hosted instances and rotating proxies), with no
  `Authorization` header sent when no key is configured.
- A system-prompt routing table for choosing between the web tools and the Firecrawl MCP tools.
