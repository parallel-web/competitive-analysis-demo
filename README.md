# Parallel.ai Competitive Analysis Demo

This is an intelligent competitive analysis tool that researches companies, finds competitors, mines reddit for user insights, and allows viewing and sharing complete reports publicly.

Check the live website: https://competitive-analysis-demo.parallel.ai

## Features

- ai company research
- competitor identification - 4-6 direct/indirect competitors
- reddit mining - authentic user opinions and sentiment
- seo-optimized shareable reports
- x/twitter auth with usage limits

## Tech stack

- cloudflare workers + durable objects
- parallel task api with reddit mcp
- simplerauth x/twitter login
- html/css/js + tailwind

## Setup

You need [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and a Cloudflare account to host this. Also

First, clone the repo and configure `wrangler.json` in a way that works for you (need to remove account_id and change or remove routes).

```bash
npm install
wrangler deploy
```
