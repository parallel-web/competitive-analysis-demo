# Small Refinements:

- Another thing to make it look much nicer, is adding icons for each company.
- 404 page for any valid hostname that includes link to `/new`
- Interlinking to hostname slug of referenced companies
- Add ability to refresh entries older after 14 days, add warning for older entries
- 401 page at `/new` should have dialog explaining login is required rather than direct redirect (to use MCP on their behalf, get 5 searches for free, get their profile info)
- Decide: parallel branding (hide logo until official @p0 launch) or separate app?

# Bigger required refinements

Find a better Reddit MCP:

- The current one has rate limits (shows "banned"). Need to find one that actually works. Or maybe replace with X MCP if none can be found

Data quality:

- Either reduce task size and complexity, or split up into task per competitor.
- Validate results: Use LLM and remove non-existing companies or have a way to filter out bad results, not making them public
- Figure out what to do with 'low confidence' outputs. Can we just hide it and assume the data is correct? A lot of fields have low confidence
- Determine if we should implement some sort of a retry mechanism if tasks have bad outputs, and what do we show the user if certain competitor analysis cannot be completed?

OAuth:

- The OAuth I'm using doesn't work on subpath so will need tweaking to make it work on oss.parallel.ai/competitors
- Simpler route: go for root subdomain or separate domain!

Other larger potential improvements:

- Adding SSE? (especially useful for seeing which mcps were used and how that went). Determine how to add it: add extra data storage (more work), or only have SSE endpoint for user at the moment of viewing loading page?
- Taxonomy and company list with most famous internet startups (great for SEO)
