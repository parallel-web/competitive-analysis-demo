# competitor analysis - ai market research

intelligent competitive analysis tool. researches companies, finds competitors, mines reddit for user insights.

## features

- ai company research
- competitor identification - 4-6 direct/indirect competitors
- reddit mining - authentic user opinions and sentiment
- seo-optimized shareable reports
- x/twitter auth with usage limits

## tech stack

- cloudflare workers + durable objects
- parallel task api with reddit mcp
- simplerauth x/twitter login
- html/css/js + tailwind

## api

- `GET /` - homepage
- `GET /new?company=domain.com` - create analysis
- `GET /analysis/{slug}` - view results
- `POST /webhook` - task completion

## setup

```bash
git clone <repo>
npm install
cp .env.example .env
npm run deploy
```

## limits

- 5 free analyses per user
- up to 10 minutes processing
- results cached and public

inspired by exa's company researcher but focused on competitive analysis with reddit insights.
