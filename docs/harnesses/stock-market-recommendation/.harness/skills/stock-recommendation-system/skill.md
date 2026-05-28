---
name: stock-recommendation-system
description: Build or operate a supervised real-time stock research system that uses market-data APIs and current web research to rank stock candidates without trade execution.
---

# stock-recommendation-system

Use this skill when the user asks to build, configure, or run a stock research
program that fetches stock data through APIs, researches analysis methods on the
web, and produces real-time recommendation candidates.

## Required Inputs

- Market/region and symbol universe.
- Market-data provider and credential source.
- Refresh interval, stale-data threshold, and whether true streaming is required.
- Web-search or financial-news source.
- Output directory for reports.
- Risk constraints, excluded sectors, and whether short-side candidates are
  allowed.

## Analysis Method

Default scorecard:

- 25 percent technical trend and momentum.
- 25 percent fundamental quality and valuation.
- 20 percent news, catalyst, and sentiment quality.
- 20 percent risk, liquidity, and volatility.
- 10 percent data freshness and confidence.

The scoring weights are defaults. If the user supplies a different investment
horizon or universe, document the adjusted weights before applying them.

## Execution Mode

**supervised-sequential-with-risk-review**

## Workflow

| Order | Task | Owner | Depends On | Deliverable |
|-------|------|-------|------------|-------------|
| 1 | Confirm scope, market, candidate universe, approved data providers, latency target, stale-data policy, and research-only output boundary. | market-data-integrator | None | `_workspace/stock_recommendation/00_scope_and_data_contract.md` |
| 2 | Design the API ingestion plan for quote, OHLCV, fundamentals, market status, optional streaming, retry/backoff, and no-secret persistence. | market-data-integrator | 1 | `_workspace/stock_recommendation/01_market_data_api_plan.md` |
| 3 | Research current analysis methods, official data/API references, company or sector catalysts, and source-risk constraints with citations. | web-research-analyst | 1 | `_workspace/stock_recommendation/02_research_basis_and_sources.md` |
| 4 | Implement or specify the transparent scoring engine using the API data contract plus researched technical, fundamental, catalyst, risk, and freshness factors. | strategy-scorer | 1-3 | `_workspace/stock_recommendation/03_scoring_engine_spec.md`, `_workspace/stock_recommendation/04_ranked_candidate_report.md` |
| 5 | Verify stale-data handling, source citations, risk vetoes, no-trade-execution policy, and recommendation wording before release. | risk-verifier | 4 | `_workspace/stock_recommendation/05_risk_verification_report.md` |

## Output Contract

The final report must include:

- Provider/feed names and data timestamps.
- Market-open or delayed-feed status.
- Per-symbol score component breakdown.
- Cited web sources with dates where available.
- Risk vetoes and uncertainty notes.
- Candidate label: `research_candidate_high`, `research_candidate_medium`,
  `watchlist`, or `reject`.

The final report must not include:

- Brokerage order payloads.
- Guaranteed-return statements.
- Personalized portfolio allocation.
- A recommendation based only on social media or one uncited source.

## Verification Plan

- Correctness: unit-test score calculations with fixed fixture candles,
  fundamentals, news signals, and missing-data cases.
- Data freshness: simulate delayed quotes, closed market, rate limits, and API
  errors.
- Safety: assert that outputs contain no trade execution fields and include
  source citations plus risk notes.
- Performance: benchmark ingestion and scoring throughput, allocations, and
  p50/p95 update latency for the expected symbol count and refresh interval.

