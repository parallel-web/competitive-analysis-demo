# September 3

✅ Initial draft for demo competitive analysis + reddit MCP: iterate on results quality, provide feedback

# September 9, 2025

## ✅ Small Refinements

- Another thing to make it look much nicer, is adding icons for each company (use: https://www.google.com/s2/favicons?domain=${domain}&sz=256)
- 404 page for any valid hostname that includes link to `/new`
- regular 404 page for invalid hostnames
- Interlinking to hostname slug of referenced competitors
- when submitting a hostname that is already there, only redirect to it if it's older younger 14 days, otherwise, refetching is in order
- Add subtle banner for ability to refresh entries older after 14 days (linking to /new), banner should explain the entry is over 2 weeks old
- 401 page at `/new` should have dialog explaining login is required rather than direct redirect (to use MCP on their behalf, get 5 searches for free, get their profile info)

## ✅ Improve results

- use parallel theme and no emojis https://assets.p0web.com
- show confidence only after clicking "show details". also show low confidence
- use Gerstner Programm for titles, do not overuse the mono font
- have liberal margins, targeting an enterprise feel for the website
- cover all fields
- ensure newlines are properly converted into html newlines

## Improve Data Quality

- ✅ Reduced task size and complexity
- ✅ Validate results: no empty fields. error when 0 competitors were found. allow retry by user
- ✅ Perceived quality is higher when confidence is only shown when 'details' is clicked

## ✅ OG image

Generate OG image png by converting from SVG with:

- Large logo
- Title: Competitor Analysis
- Subtitle: [Company name]
- bottom row: logos of all competitors

use: https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64

use https://assets.p0web.com style

use https://svg.quickog.com

## OAuth ❌

- The OAuth I'm using doesn't work on subpath so will need tweaking to make it work on oss.parallel.ai/competitors
- Simpler route: go for root subdomain or separate domain!
- Discuss

Verdict now: let's put on competitors.parallel.ai

## Find a better Reddit MCP ❌

The current one has rate limits (shows "banned"). Need to find one that actually works. Or maybe replace with X MCP if none can be found.

- Reddit API ratelimits: https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- Reddit Data API Usage terms: https://redditinc.com/policies/data-api-terms
- Reddit Developer terms: https://redditinc.com/policies/developer-terms
- Reddit Blocking Search Crawlers: https://www.theverge.com/2024/7/24/24205244/reddit-blocking-search-engine-crawlers-ai-bot-google
- Reddit robots.txt update: https://news.ycombinator.com/item?id=40895715

https://wilmake.slack.com/archives/C09807JBB26/p1757423515906089

Verdict now:

- Changing to X MCP is tricky due to even stricter data laws and we gotta pay for data there.
- Keep current MCP until we get into trouble.

# Small improvements

✅ Switch to "ultra2x" or "ultra" if it works

✅ under "this will take about 30 minutes" you can say -- feel free to close this tab and come back later or something

✅ agree on hiding confidence levels fornow

# Task splitting

Split up task into several smaller tasks? Main details, Competive landscape, Feature comparison, Pricing analysis. However, maybe, it makes more sense to perform immediate follow-up tasks for eacah competitor when entering a new competitor. This provides a simpler setup of just 1 task per company, with rich competitor info by linking the comptetitor.

The result page can then be enriched by not just providing the main company result, but also adding a table for all competitors with key details.

We can't do this endlessly though so there will be weak links that have no competition analyzed (or not all, at least). For this, maybe we should add a button to perform analysis for competition in this section (add a DB property: `has_analyzed_competitors:0|1`).

✅ New analysis now does perform DEEP analysis (all competitor hostnames get analyzed as well)

# Markdown version and MCP

✅ Markdown version for analysis + all competitors

✅ MCP should only have access to `/md/{hostname}` endpoint. This shuld be able to be hosted at smithery.

## Add LLM validation logic

Problem: some competitors end up being sub-products of other companies and don't have their own (sub)domain, resulting in the fact that hostname is not correct. If we however allow for any `/subpath`, quality control wouldn't be sufficient. Quality control probably already isn't sufficient. Maybe, we should add validator properties such as `company_fits_criteria:boolean` into the datastructure and filter out based on that. This is great anyway!

After we have proper LLM validation, allow /subpaths too in `/new`

To test whether or not this works, let's see the results of 10 new companies

## Categorization

- Add categorization (enum "category" field with up to 15 high level categories)
- Allow viewing all analyses in a category

# Bigger required refinements

Do more to improve data quality:

- Figure out what to do with 'low confidence' outputs. Can we just hide it and assume the data is correct? A lot of fields have low confidence
- Determine if we should implement some sort of a retry mechanism if tasks have bad outputs, and what do we show the user if certain competitor analysis cannot be completed?

Other larger potential improvements:

- Adding SSE? (especially useful for seeing which MCPs were used and how that went). Determine how to add it: add extra data storage (more work), or only have SSE endpoint for user at the moment of viewing loading page?
