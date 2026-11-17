---
name: seo-weekly-report
description: "Generate a weekly SEO performance report for a Search Console property. Use when asked for a site summary, performance overview, or weekly report."
---

# SEO Weekly Report

## Steps

1. Call `list_sites` to confirm the exact `siteUrl`.
2. Call `get_site_overview` with `days: 28` for totals and the change against the previous 28 days.
3. Call `compare_periods` with `days: 28`, `dimensions: ["query"]`, `sortBy: "clicksLost"`, `limit: 20`. Flag queries that lost more than 20% of their clicks.
4. Call `search_analytics_query` with `days: 28`, `dimensions: ["query"]`, `rowLimit: 10` for the top 10 queries by clicks.

## Output format

A markdown report: summary table (totals and change), alerts with a one-line recommendation each, top 10 queries.
