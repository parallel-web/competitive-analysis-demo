/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />
import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { DurableObject } from "cloudflare:workers";
import { UserContext, withSimplerAuth } from "simplerauth-client";
import { Parallel } from "parallel-web";
//@ts-ignore
import indexHtml from "./index.html";
//@ts-ignore
import resultHtml from "./result.html";

const DO_NAME = "v3";
const ADMIN_USERNAME = "janwilmake";
export interface Env {
  COMPETITOR_ANALYSIS: DurableObjectNamespace<
    CompetitorAnalysisDO & QueryableHandler
  >;
  PARALLEL_API_KEY: string;
  PARALLEL_WEBHOOK_SECRET: string;
  MCP_URL: string;
}

interface AnalysisRow {
  slug: string;
  company_domain: string;
  company_name: string;
  status: "pending" | "done";
  username: string;
  profile_image_url: string;
  created_at: string;
  updated_at: string;
  visits: number;
  result: string | null;
  error: string | null;
}

function createSlug(domain: string): string {
  return domain.replace(/\./g, "-").toLowerCase();
}

function getCompanyName(domain: string): string {
  // Extract company name from domain
  const parts = domain.split(".");
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return withSimplerAuth<Env>(
      async (request, env, ctx) => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        const do_id = env.COMPETITOR_ANALYSIS.idFromName(DO_NAME);
        const do_stub = env.COMPETITOR_ANALYSIS.get(do_id);

        switch (pathname) {
          case "/admin": {
            if (ctx.user?.username !== ADMIN_USERNAME) {
              return new Response("Admin only");
            }
            return studioMiddleware(request, do_stub.raw, {
              dangerouslyDisableAuth: true,
            });
          }

          case "/":
            return handleHome(do_stub);

          case "/new":
            return handleNew(request, do_stub, ctx, env);

          case "/webhook":
            return handleWebhook(request, do_stub, env);

          default:
            if (pathname.startsWith("/analysis/")) {
              const slug = pathname.replace("/analysis/", "");
              return handleResult(url, slug, do_stub);
            }
            return new Response("Not Found", { status: 404 });
        }
      },
      { isLoginRequired: false }
    )(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handleHome(
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const popular = await do_stub.getPopularAnalyses(6);
  const recent = await do_stub.getRecentAnalyses(30);

  const createCards = (analyses: AnalysisRow[]) => {
    if (analyses.length === 0) {
      return `<div class="text-center py-12">
        <p class="text-gray-500 text-lg">No analyses yet. Be the first to research a company!</p>
      </div>`;
    }

    return analyses
      .map((analysis) => {
        const initial = analysis.company_name.charAt(0).toUpperCase();
        return `
        <div class="company-card" onclick="window.location.href='/analysis/${
          analysis.slug
        }'">
          <div class="flex items-center space-x-4 mb-4">
            <div class="company-logo">${initial}</div>
            <div>
              <h4 class="font-semibold text-lg">${escapeHtml(
                analysis.company_name
              )}</h4>
              <p class="text-sm text-gray-500">${escapeHtml(
                analysis.company_domain
              )}</p>
            </div>
          </div>
          <p class="text-gray-600 text-sm mb-3">
            Competitive analysis with market insights and Reddit community opinions
          </p>
          <div class="flex items-center justify-between text-xs text-gray-500">
            <span>📊 Analysis available</span>
            <span>🔥 ${analysis.visits} views</span>
          </div>
        </div>
      `;
      })
      .join("");
  };

  const popularCards = createCards(popular);
  const recentCards = createCards(recent);

  let html = indexHtml;

  // Replace popular section
  html = html.replace(
    /<section id="popular"[\s\S]*?<\/section>/,
    `<section id="popular" class="py-16 px-6 neural-bg">
        <div class="max-w-6xl mx-auto">
            <h3 class="gerstner text-3xl font-medium mb-12 text-center index-black-text">
                Popular Analyses
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                ${popularCards}
            </div>
        </div>
    </section>`
  );

  // Replace recent section
  html = html.replace(
    /<section id="recent"[\s\S]*?<\/section>/,
    `<section id="recent" class="py-16 px-6 neural-bg">
        <div class="max-w-6xl mx-auto">
            <h3 class="gerstner text-3xl font-medium mb-12 text-center index-black-text">
                Recent Analyses
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                ${recentCards}
            </div>
        </div>
    </section>`
  );

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleNew(
  request: Request,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>,
  ctx: UserContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");

  if (!company || company.trim().length === 0) {
    return new Response("Company domain is required", { status: 400 });
  }

  if (!ctx.authenticated) {
    const redirectUrl = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/authorize?redirect_to=${encodeURIComponent(redirectUrl)}`,
      },
    });
  }

  const domain = company.trim().toLowerCase();
  const slug = createSlug(domain);
  const companyName = getCompanyName(domain);

  // Check user limits and slug existence
  const userAnalyses = await do_stub.getUserAnalysisCount(ctx.user?.username);
  if (userAnalyses >= 5 && ctx.user.username !== ADMIN_USERNAME) {
    return new Response(
      "Maximum of 5 analyses allowed per user. Host it yourself if you need more! \n\nhttps://github.com/janwilmake/competitor-analysis",
      { status: 429 }
    );
  }

  const existingAnalysis = await do_stub.getAnalysis(slug);
  if (existingAnalysis) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/analysis/${slug}`,
      },
    });
  }

  // Create analysis task
  const parallel = new Parallel({ apiKey: env.PARALLEL_API_KEY });

  try {
    const taskRun = await parallel.beta.taskRun.create(
      {
        input: `Conduct comprehensive competitive intelligence analysis for company: ${domain} including a Reddit sentiment analysis`,
        processor: "pro",
        metadata: { slug },
        mcp_servers: [
          {
            name: "Reddit",
            url: env.MCP_URL,
            type: "url",
          },
        ],
        webhook: {
          url: `${url.protocol}//${url.host}/webhook`,
          event_types: ["task_run.status"],
        },
        task_spec: {
          output_schema: {
            type: "json",
            json_schema: {
              type: "object",
              description:
                "Extract comprehensive competitive intelligence using deep web research across news, financial databases, social media, forums, and industry reports. Prioritize recent data and authoritative sources.",
              required: [
                "company_name",
                "company_domain",
                "headquarters_location",
                "industry_sector",
                "employee_count",
                "business_description",
                "unique_value_proposition",
                "target_market_analysis",
                "recent_news_developments",
                "market_size_and_growth",
                "competitive_landscape_overview",
                "competitors",
                "target_company_reddit_analysis",
                "reddit_competitive_insights",
                "executive_summary",
              ],
              additionalProperties: false,
              properties: {
                // Essential Company Information
                company_name: {
                  type: "string",
                  description: "Full legal name of the company",
                },
                company_domain: {
                  type: "string",
                  description: "Primary website domain",
                },
                headquarters_location: {
                  type: "string",
                  description:
                    "City, State/Province, Country where company headquarters is located",
                },
                industry_sector: {
                  type: "string",
                  description:
                    "Primary industry sector and specific vertical with market context",
                },
                employee_count: {
                  type: "string",
                  description:
                    "Current number of employees as specific number or range with source date",
                },
                linkedin_url: {
                  type: "string",
                  description:
                    "Official LinkedIn company page URL, or 'Not found' if unavailable",
                },
                founded_year: {
                  type: "string",
                  description: "Year the company was founded",
                },
                total_funding_raised: {
                  type: "string",
                  description:
                    "Total amount of funding raised with currency, or 'Not disclosed' if unknown",
                },
                latest_funding_round: {
                  type: "string",
                  description:
                    "Most recent funding round with amount, type, date, and lead investor if available",
                },
                current_valuation: {
                  type: "string",
                  description:
                    "Most recent company valuation if available, or 'Not publicly disclosed'",
                },

                // Business Analysis
                business_description: {
                  type: "string",
                  description:
                    "Comprehensive 2-3 paragraph description of the company's core business, products, services, target customers, and revenue model. Include specific product names and key differentiators.",
                },
                target_market_analysis: {
                  type: "string",
                  description:
                    "1-2 paragraph analysis of the company's target market segments, customer demographics, geographic focus, and market positioning strategy.",
                },
                recent_news_developments: {
                  type: "string",
                  description:
                    "summary of significant company developments, product launches, partnerships, leadership changes, or strategic moves from the last 6-12 months with specific dates and details.",
                },

                // Market Context
                market_size_and_growth: {
                  type: "string",
                  description:
                    "Detailed analysis of the total addressable market size, growth rates, key market drivers, and future projections for the industry the company operates in.",
                },

                // Competitor Analysis
                competitors: {
                  type: "array",
                  description:
                    "2-4 key direct competitors with comprehensive analysis including Reddit sentiment for each",
                  items: {
                    type: "object",
                    required: [
                      "name",
                      "website",
                      "description",
                      "strengths",
                      "weaknesses",
                      "reddit_sentiment",
                    ],
                    additionalProperties: false,
                    properties: {
                      name: {
                        type: "string",
                        description: "Competitor company name",
                      },
                      website: {
                        type: "string",
                        description: "Competitor website URL",
                      },
                      description: {
                        type: "string",
                        description:
                          "1 paragraph overview of this competitor including their business model, key products/services, target customers, market position, and recent strategic developments",
                      },
                      strengths: {
                        type: "string",
                        description:
                          "Detailed paragraph analyzing this competitor's key competitive advantages, unique capabilities, market position strengths, and areas where they outperform others",
                      },
                      weaknesses: {
                        type: "string",
                        description:
                          "Detailed paragraph analyzing this competitor's vulnerabilities, market gaps, operational challenges, and areas where they lag behind the target company or other competitors",
                      },
                      market_share: {
                        type: "string",
                        description:
                          "Estimated market share, market position ranking, or competitive standing with context",
                      },
                      reddit_sentiment: {
                        type: "string",
                        description:
                          "Paragraph analyzing Reddit community discussions about this competitor, including overall sentiment, key discussion themes, user experiences, and how they're perceived relative to others in the market",
                      },
                    },
                  },
                },

                // Reddit Intelligence
                target_company_reddit_analysis: {
                  type: "string",
                  description:
                    "Comprehensive paragraph analysis of Reddit discussions specifically about the target company, including common themes, user experiences, comparisons to competitors, and insights from relevant subreddits.",
                },
                reddit_overall_sentiment: {
                  type: "string",
                  description:
                    'Overall sentiment of the target company on Reddit, "low", "medium" or "high"',
                },

                // Strategic Analysis
                market_opportunities: {
                  type: "string",
                  description:
                    "2-3 paragraph analysis of underserved market segments, emerging trends, geographic expansion opportunities, or product/service gaps that represent growth opportunities for the target company.",
                },

                // Executive Summary
                executive_summary: {
                  type: "string",
                  description:
                    "Comprehensive 3-4 paragraph executive summary covering the company's current market position, key competitive dynamics, most significant opportunities and threats, and critical strategic implications. Written for senior leadership decision-making.",
                },
              },
            },
          },
        },
      },
      {
        headers: {
          "parallel-beta": "mcp-server-2025-07-17,webhook-2025-08-12",
        },
      }
    );

    await do_stub.createAnalysis({
      slug,
      company_domain: domain,
      company_name: companyName,
      status: "pending",
      username: ctx.user.username,
      profile_image_url: ctx.user.profile_image_url || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      visits: 0,
      result: null,
      error: null,
    });

    return new Response(null, {
      status: 302,
      headers: { Location: `/analysis/${slug}` },
    });
  } catch (error) {
    console.error("Error creating analysis task:", error);
    return new Response("Error creating analysis task", { status: 500 });
  }
}

async function handleWebhook(
  request: Request,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  console.log("Handling webhook");
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const webhookSignature = request.headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return new Response("Missing webhook headers", { status: 400 });
  }

  const body = await request.text();
  const isSignatureValid = await verifyWebhookSignature(
    env.PARALLEL_WEBHOOK_SECRET,
    webhookId,
    webhookTimestamp,
    body,
    webhookSignature
  );

  if (!isSignatureValid) {
    return new Response("Invalid signature", { status: 401 });
  }
  const payload = JSON.parse(body);
  console.log("Signature valid", { payload });

  if (
    payload.type === "task_run.status" &&
    payload.data.status === "completed"
  ) {
    const slug = payload.data.metadata?.slug;
    if (!slug) {
      return new Response("Missing slug in metadata", { status: 400 });
    }

    try {
      const parallel = new Parallel({ apiKey: env.PARALLEL_API_KEY });
      const result = await parallel.taskRun.result(payload.data.run_id);

      if (result.output.type === "json") {
        await do_stub.updateAnalysisResult(slug, JSON.stringify(result), null);
      } else {
        await do_stub.updateAnalysisResult(
          slug,
          null,
          "Unexpected output format"
        );
      }
    } catch (error) {
      console.error("Error fetching result:", error);
      await do_stub.updateAnalysisResult(slug, null, "Error fetching result");
    }
  } else if (
    payload.type === "task_run.status" &&
    payload.data.status === "failed"
  ) {
    const slug = payload.data.metadata?.slug;
    if (slug) {
      await do_stub.updateAnalysisResult(
        slug,
        null,
        payload.data.error?.message || "Analysis failed"
      );
    }
  }

  return new Response("OK");
}

async function handleResult(
  url: URL,
  slug: string,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const analysis = await do_stub.getAnalysis(slug);

  if (!analysis) {
    return new Response("Analysis not found", { status: 404 });
  }

  if (analysis.status === "done" && !analysis.error) {
    await do_stub.incrementVisits(slug);
  }

  let html = resultHtml;

  // Inject dynamic title and meta tags
  const pageTitle = `${analysis.company_name} Competitive Analysis - Market Research`;
  const description =
    analysis.status === "done" && !analysis.error
      ? `Comprehensive competitive analysis for ${analysis.company_name}. Discover key competitors, market insights, and Reddit community opinions with AI-powered research.`
      : `Analyzing ${analysis.company_name}'s competitive landscape. Check back soon for comprehensive market research and competitor insights.`;

  // Replace title
  html = html.replace(
    /<title>.*?<\/title>/i,
    `<title>${escapeHtml(pageTitle)}</title>`
  );

  // Inject meta tags
  const metaTags = `
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="keywords" content="competitive analysis, market research, ${escapeHtml(
      analysis.company_name
    )}, competitors, business intelligence">
    <meta name="author" content="Competitor Analysis">
    
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${url.origin}/analysis/${slug}">
    <meta property="og:title" content="${escapeHtml(pageTitle)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:site_name" content="Competitor Analysis">
    
    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${url.origin}/analysis/${slug}">
    <meta property="twitter:title" content="${escapeHtml(pageTitle)}">
    <meta property="twitter:description" content="${escapeHtml(description)}">
    
    <!-- Additional SEO -->
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${url.origin}/analysis/${slug}">
  `;

  html = html.replace("</head>", `${metaTags}</head>`);

  // Inject dynamic data
  const result = analysis.result ? JSON.parse(analysis.result) : null;

  if (result?.output?.["beta_fields"]?.["mcp-server-2025-07-17"]) {
    result.output.mcp_tool_calls =
      result?.output?.["beta_fields"]?.["mcp-server-2025-07-17"];
  }

  const data = {
    analysis: {
      ...analysis,
      result,
    },
  };

  html = html.replace(
    "</head>",
    `<script>window.data = ${JSON.stringify(data)}</script></head>`
  );

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function verifyWebhookSignature(
  secret: string,
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  signatureHeader: string
): Promise<boolean> {
  const payload = `${webhookId}.${webhookTimestamp}.${body}`;

  for (const part of signatureHeader.split(" ")) {
    if (part.startsWith("v1,")) {
      const receivedSignature = part.substring(3);

      const arr = await crypto.subtle
        .importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        )
        .then((key) =>
          crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
        )
        .then((sig) => new Uint8Array(sig));

      const expectedSignature = btoa(
        String.fromCharCode(...new Uint8Array(arr))
      );

      if (receivedSignature === expectedSignature) {
        return true;
      }
    }
  }

  return false;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
@Queryable()
export class CompetitorAnalysisDO extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initDatabase();
  }

  private initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        slug TEXT PRIMARY KEY,
        company_domain TEXT NOT NULL,
        company_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
        username TEXT NOT NULL,
        profile_image_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        visits INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT
      )
    `);
  }

  async createAnalysis(
    analysis: Omit<AnalysisRow, "visits"> & { visits?: number }
  ): Promise<void> {
    this.sql.exec(
      `
      INSERT INTO analyses (slug, company_domain, company_name, status, username, profile_image_url, created_at, updated_at, visits, result, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      analysis.slug,
      analysis.company_domain,
      analysis.company_name,
      analysis.status,
      analysis.username,
      analysis.profile_image_url,
      analysis.created_at,
      analysis.updated_at,
      analysis.visits || 0,
      analysis.result,
      analysis.error
    );
  }

  async getAnalysis(slug: string): Promise<AnalysisRow | null> {
    const results = this.sql.exec(
      "SELECT * FROM analyses WHERE slug = ?",
      slug
    );
    const rows = results.toArray();
    return rows.length > 0 ? (rows[0] as AnalysisRow) : null;
  }

  async getUserAnalysisCount(username: string): Promise<number> {
    const results = this.sql.exec(
      "SELECT COUNT(*) as count FROM analyses WHERE username = ?",
      username
    );
    const rows = results.toArray();
    return (rows[0] as any).count;
  }

  async updateAnalysisResult(
    slug: string,
    result: string | null,
    error: string | null
  ): Promise<void> {
    const status = "done"; // Both success and error are considered "done"
    this.sql.exec(
      `
      UPDATE analyses 
      SET status = ?, result = ?, error = ?, updated_at = ?
      WHERE slug = ?
    `,
      status,
      result,
      error,
      new Date().toISOString(),
      slug
    );
  }

  async incrementVisits(slug: string): Promise<void> {
    this.sql.exec(
      "UPDATE analyses SET visits = visits + 1 WHERE slug = ?",
      slug
    );
  }

  async getPopularAnalyses(limit: number): Promise<AnalysisRow[]> {
    const results = this.sql.exec(
      `
      SELECT * FROM analyses 
      WHERE status = 'done' AND error IS NULL
      ORDER BY visits DESC 
      LIMIT ?
    `,
      limit
    );
    return results.toArray() as AnalysisRow[];
  }

  async getRecentAnalyses(limit: number): Promise<AnalysisRow[]> {
    const results = this.sql.exec(
      `
      SELECT * FROM analyses 
      WHERE status = 'done' AND error IS NULL
      ORDER BY created_at DESC 
      LIMIT ?
    `,
      limit
    );
    return results.toArray() as AnalysisRow[];
  }
}
