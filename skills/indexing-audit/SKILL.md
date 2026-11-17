---
name: indexing-audit
description: "Audit indexing status of the most visible pages. Use when asked about crawling, indexing issues, or whether pages are indexed by Google."
---

# Indexing Audit

URL inspections are scarce (about 2,000 per property per day), so call `get_quota_status` first.

## Steps

1. Call `find_deindexed_pages` for pages with impressions that are not indexed (it reuses recorded inspections, or inspects the top pages). `inspect_top_pages` refreshes the top pages.
2. Call `index_diff` for what changed since each page's previous inspection (or pass `since` with a deploy time, ISO 8601).
3. For other doubts, call `batch_inspect_urls` on a few URLs only.

## Output format

Group findings: Critical (not indexed but has impressions), High (Google's canonical differs from the declared one), Medium (robots.txt or fetch blocks), Low (soft exclusions). End with a table: URL | verdict | issue | action.
