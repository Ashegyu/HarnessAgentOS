# Stock Market Recommendation System Harness

This directory is an importable Harness-native package for building or operating
a supervised stock research and recommendation-candidate system.

Import path:

```text
C:\Users\GC\Desktop\Works\Personal\Study\HarnessAgentOS\docs\harnesses\stock-market-recommendation
```

Use it from the Harnesses tab with `Import directory`. Bind each abstract agent
to reviewed `AgentProfile` rows before previewing or running the workflow.

The package is deliberately research-only. It does not store API keys, place
orders, automate brokerage actions, or emit personalized financial advice.
Market-data APIs, web search, and report file writes must remain approval-gated
capabilities.

Expected runtime secrets are environment variables or user-provided connector
configuration, not source files:

- `ALPHA_VANTAGE_API_KEY` for broad equity, fundamentals, indicator, and market
  status access.
- `POLYGON_API_KEY` or `MASSIVE_API_KEY` for true streaming U.S. equity market
  data where the account plan permits it.
- `FRED_API_KEY` for optional macroeconomic series.
- Optional news/search provider credentials if the bound profile uses a paid
  search or news API.

