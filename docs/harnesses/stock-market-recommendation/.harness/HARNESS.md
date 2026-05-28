# Stock Market Recommendation System Harness

Build or operate a supervised stock research system that combines live market
data APIs, current web research, technical/fundamental scoring, and risk review
to produce ranked stock research candidates.

## Scope

This harness is for a program that:

- Pulls quote, OHLCV, fundamentals, indicator, market-status, and macro data
  from approved financial APIs.
- Uses web search to refresh the analysis method, source citations, current
  catalysts, and risk context.
- Produces timestamped ranked research candidates with evidence, confidence,
  data-freshness labels, and explicit risk notes.
- Stops short of brokerage integration, order placement, guarantees, or
  personalized investment advice.

## Researched Basis

- Alpha Vantage documents equity time series, quote, fundamentals, market
  status, and technical indicator endpoints:
  https://www.alphavantage.co/documentation/
- Polygon/Massive documents stock WebSocket feeds for real-time trades, quotes,
  aggregates, LULD, and FMV data:
  https://massive.com/docs/websocket/stocks/overview
- FRED documents API access for economic series, observations, releases, and
  search:
  https://fred.stlouisfed.org/docs/api/fred/
- Schwab describes a practical stock-selection flow that narrows a fundamental
  candidate list with technical screening, moving averages, momentum, volume,
  and chart context:
  https://www.schwab.com/learn/story/how-to-pick-stocks-using-fundamental-and-technical-analysis
- SEC investor education emphasizes risk, diversification, and asset allocation
  instead of single-stock certainty:
  https://www.sec.gov/about/reports-publications/investorpubsassetallocationhtm
- Investor.gov warns that stock recommendations from social media or apps can
  be scams and should not be the sole basis for investment decisions:
  https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/social-media-stock-scams

## Output Policy

Every recommendation output must include:

- Data timestamp, provider, endpoint/feed, market-open status, and stale-data
  flags.
- Evidence for each score component and links or identifiers for web sources.
- Separate technical, fundamental, catalyst/news, liquidity, volatility, and
  macro/risk scores.
- A final label such as `research_candidate_high`, `research_candidate_medium`,
  `watchlist`, or `reject`, not a guaranteed buy/sell instruction.
- A risk-review section that can veto a candidate.

## Safety Limits

- Do not execute trades or generate broker order payloads.
- Do not promise returns.
- Do not base output only on social media, chat rooms, or one unverified source.
- Do not hide data freshness, delayed-feed status, rate-limit gaps, or missing
  fundamentals.
- Do not persist API keys in generated files.

