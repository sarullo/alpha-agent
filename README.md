# Alpha Agent

Automated stock research + Bitcoin cycle analysis delivered by email daily.

## Agents
- **Stock Agent** — runs weekdays at 9:30am ET, picks top 5 movers, emails analysis
- **Bitcoin Agent** — runs every Monday at 8am ET, cycle analysis with key indicators

## Setup

### 1. Add secrets to GitHub
Go to your repo → Settings → Secrets and variables → Actions → New repository secret

Add these 5 secrets:
- `ANTHROPIC_API_KEY`
- `ALPACA_KEY`
- `ALPACA_SECRET`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`

### 2. Enable Actions
Go to Actions tab in your repo and enable workflows.

### 3. Manual trigger
Go to Actions → pick a workflow → Run workflow

## Files
- `agent.js` — stock research agent
- `btc-agent.js` — bitcoin cycle agent
- `.github/workflows/stock-agent.yml` — stock agent schedule
- `.github/workflows/btc-agent.yml` — bitcoin agent schedule
