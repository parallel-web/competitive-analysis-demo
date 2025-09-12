# Parallel.ai Competitive Analysis Demo

This is an intelligent competitive analysis tool that researches companies, finds competitors, mines reddit for user insights, and allows viewing and sharing complete reports publicly.

Check the live website: https://competitive-analysis-demo.parallel.ai

## Features

- ai company research
- competitor identification - 4-6 direct/indirect competitors
- reddit mining - authentic user opinions and sentiment
- seo-optimized shareable reports
- x/twitter auth with usage limits
- search
- admin panel
- mcp

## Tech stack

- cloudflare workers + durable objects
- parallel task api with reddit mcp
- simplerauth x/twitter login
- html/css/js + tailwind

## Setup

You need [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and a Cloudflare account to host this.

First, clone the repo and configure `wrangler.json` in a way that works for you (need to remove account_id and change or remove routes).

```bash
npm install
wrangler deploy
```

## Working with production data locally

To easily get data into your app, run some analyses after deploying.

If you want to have the same data locally, you can export/import through the admin panel:

1. visit https://yourdomain.com/admin and export your table as JSON
2. visit http://localhost:8787/admin?page=import and import that file as table `analyses`
