---
name: cannibalization-check
description: "Detect keyword cannibalization, queries where several pages of the site compete. Use when asked about competing pages, keyword overlap, or cannibalization."
---

# Cannibalization Check

## Steps

1. Call `find_cannibalization` (defaults; raise `minPageSharePct` to cut noise).
2. For each case pick the page to keep (better position or CTR) and decide between a canonical, a redirect or a content merge.

## Output format

A markdown table (query | pages with share/position | severity by impressions at stake), then a prioritized action list.
