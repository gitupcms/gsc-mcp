---
name: content-opportunities
description: "Find quick-win content targets: page-2 rankings and pages whose CTR fell while impressions grew. Use when asked for content ideas or optimization opportunities."
---

# Content Opportunities

## Steps

1. Call `find_ctr_opportunities` (defaults): pages whose impressions grew but CTR fell, already prioritized.
2. Call `search_analytics_query` with `days: 28`, `dimensions: ["query", "page"]`, `rowLimit: 1000`. Keep rows with position 11-20, impressions > 100 and ctr < 0.03. Score = impressions x (0.05 - ctr).
3. For the top pages, `get_page_queries` shows every query a page ranks for.

## Output format

A table (query | page | position | impressions | CTR | score), top 20, then concrete title/meta, internal-link or merge suggestions.
