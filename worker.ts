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

const DO_NAME = "v5";
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
  hostname: string; // Changed from slug to hostname
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

function getCompanyName(domain: string): string {
  // Extract company name from domain
  const parts = domain.split(".");
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

function isValidDomain(domain: string): boolean {
  const domainRegex =
    /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z]{2,})+$/;
  return domainRegex.test(domain);
}

async function isValidHostname(hostname: string): Promise<boolean> {
  // First check if it looks like a valid domain
  if (!isValidDomain(hostname)) {
    return false;
  }

  try {
    // Use DNS over HTTPS to check if the domain resolves
    // This is more reliable than HTTP requests and works from Cloudflare Workers
    const dnsUrl = `https://1.1.1.1/dns-query?name=${encodeURIComponent(
      hostname
    )}&type=A`;

    const response = await fetch(dnsUrl, {
      method: "GET",
      headers: {
        Accept: "application/dns-json",
      },
      signal: AbortSignal.timeout(3000), // Reduced timeout since DNS is faster
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as {
      Status: number;
      Answer?: Array<{ type: number; data: string }>;
    };

    // Status 0 = NOERROR, meaning the domain exists
    // Check if we got any A records or if the domain exists (even with no A records)
    return (
      data.Status === 0 &&
      ((data.Answer && data.Answer.length > 0) ||
        // Some domains might not have A records but still exist (e.g., MX only)
        data.Status === 0)
    );
  } catch (error) {
    // Fallback: try a different DNS provider
    try {
      const fallbackUrl = `https://dns.google/resolve?name=${encodeURIComponent(
        hostname
      )}&type=A`;

      const response = await fetch(fallbackUrl, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as {
        Status: number;
        Answer?: Array<{ type: number; data: string }>;
      };

      return data.Status === 0;
    } catch (fallbackError) {
      // If both DNS queries fail, assume invalid
      return false;
    }
  }
}

function isAnalysisOld(createdAt: string): boolean {
  const createdDate = new Date(createdAt);
  const now = new Date();
  const diffInMs = now.getTime() - createdDate.getTime();
  const diffInDays = diffInMs / (1000 * 60 * 60 * 24);
  return diffInDays > 14;
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
              const hostname = pathname.replace("/analysis/", "");
              return handleResult(url, hostname, do_stub);
            }
            if (pathname.startsWith("/og/")) {
              const hostname = pathname.replace("/og/", "");
              return handleOg(hostname, do_stub);
            }
            return handle404();
        }
      },
      { isLoginRequired: false }
    )(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handle404(): Promise<Response> {
  // Regular 404 for invalid hostnames
  return new Response(
    `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Page Not Found</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body { font-family: 'system-ui', sans-serif; }
        </style>
      </head>
      <body class="min-h-screen bg-gray-50 flex items-center justify-center">
        <div class="max-w-md mx-auto text-center p-8">
          <div class="w-16 h-16 mx-auto mb-6 bg-gray-100 text-gray-600 rounded-full flex items-center justify-center">
            <span class="text-3xl font-bold">404</span>
          </div>
          <h1 class="text-2xl font-bold text-gray-900 mb-4">Page Not Found</h1>
          <p class="text-gray-600 mb-6">
            The page you're looking for doesn't exist.
          </p>
          <div class="space-y-3">
            <a href="/" 
               class="inline-block bg-gradient-to-r from-orange-500 to-red-500 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
              Go Home
            </a>
            <div>
              <a href="/new" class="text-sm text-gray-500 hover:text-gray-700 underline">
                Start a new analysis
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    {
      status: 404,
      headers: { "Content-Type": "text/html" },
    }
  );
}

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
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
          analysis.company_domain
        )}&sz=64`;

        return `
        <div class="company-card" onclick="window.location.href='/analysis/${
          analysis.hostname
        }'">
          <div class="flex items-center space-x-4 mb-4">
            <div class="company-logo-container relative">
              <img src="${faviconUrl}" 
                   alt="${escapeHtml(analysis.company_name)} logo"
                   class="w-12 h-12 rounded-lg object-cover"
                   onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
              <div class="company-logo w-12 h-12 hidden">${initial}</div>
            </div>
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

async function handleOg(
  hostname: string,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const analysis = await do_stub.getAnalysis(hostname);

  if (
    !analysis ||
    analysis.status !== "done" ||
    analysis.error ||
    !analysis.result
  ) {
    // Return a default SVG if analysis not found or incomplete
    return new Response(createDefaultOgSvg(hostname), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const result = JSON.parse(analysis.result);
  const analysisData = result.output?.content || {};

  const companyName = analysisData.company_name || analysis.company_name;
  const competitors = analysisData.competitors || [];

  const svg = createCompetitorAnalysisOgSvg(companyName, hostname, competitors);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function createDefaultOgSvg(hostname: string): string {
  const companyName = getCompanyName(hostname);

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        @import url('https://assets.p0web.com/Gerstner-ProgrammMedium.woff2');
        @import url('https://assets.p0web.com/FTSystemMono-Medium.woff2');
        .gerstner { font-family: 'Gerstner Programm', system-ui, sans-serif; }
        .ft-mono { font-family: 'FT System Mono', monospace; }
      </style>
    </defs>
    
    <!-- Background -->
    <rect width="1200" height="630" fill="#fcfcfa"/>
    
    <!-- Large company logo - top left -->
    <g transform="translate(120, 120)">
      <circle cx="0" cy="0" r="80" fill="#d8d0bf" opacity="0.3"/>
      <image x="-60" y="-60" width="120" height="120" 
             href="https://www.google.com/s2/favicons?domain=${encodeURIComponent(
               hostname
             )}&amp;sz=128" 
             opacity="0.9"/>
    </g>
    
    <!-- Title and subtitle beside logo -->
    <g transform="translate(240, 80)">
      <text x="0" y="0" class="gerstner" font-size="52" font-weight="500" fill="#1d1b16">
        Competitor Analysis
      </text>
      <text x="0" y="80" class="ft-mono" font-size="36" font-weight="400" fill="#fb631b">
        ${escapeXml(companyName)}
      </text>
    </g>
    
    <!-- Analysis pending message -->
    <text x="600" y="400" text-anchor="middle" class="ft-mono" font-size="24" fill="#1d1b16" opacity="0.6">
      Analysis in progress...
    </text>
    
    <!-- Domain -->
    <text x="600" y="560" text-anchor="middle" class="ft-mono" font-size="18" fill="#1d1b16" opacity="0.5">
      ${escapeXml(hostname)}
    </text>
  </svg>`;
}

function createCompetitorAnalysisOgSvg(
  companyName: string,
  hostname: string,
  competitors: Array<{ name: string; website: string }>
): string {
  // Limit competitors to 6 max and spread across full width
  const displayCompetitors = competitors.slice(0, 6);

  // Calculate positions to spread across full width (with margins)
  const margin = 100;
  const availableWidth = 1200 - 2 * margin;
  const spacing =
    displayCompetitors.length > 1
      ? availableWidth / (displayCompetitors.length - 1)
      : 0;
  const startX = margin;

  const competitorLogos = displayCompetitors
    .map((competitor, index) => {
      const x =
        displayCompetitors.length === 1 ? 600 : startX + index * spacing;
      const domain = competitor.website
        ? competitor.website.replace(/^https?:\/\//, "").replace(/\/$/, "")
        : "";
      const faviconUrl = domain
        ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
            domain
          )}&amp;sz=64`
        : "";

      return `
      <g transform="translate(${x}, 480)">
        <!-- Background circle -->
        <circle cx="0" cy="0" r="40" fill="#d8d0bf" opacity="0.2"/>
        ${
          faviconUrl
            ? `
        <!-- Company favicon -->
        <image x="-30" y="-30" width="60" height="60" href="${faviconUrl}" opacity="0.9"/>
        `
            : `
        <!-- Fallback icon -->
        <circle cx="0" cy="0" r="30" fill="#fb631b" opacity="0.3"/>
        <text x="0" y="8" text-anchor="middle" class="gerstner" font-size="24" font-weight="500" fill="#1d1b16">
          ${competitor.name.charAt(0).toUpperCase()}
        </text>
        `
        }
        <!-- Company name -->
        <text x="0" y="65" text-anchor="middle" class="ft-mono" font-size="14" fill="#1d1b16" opacity="0.7">
          ${escapeXml(
            competitor.name.length > 15
              ? competitor.name.substring(0, 15) + "..."
              : competitor.name
          )}
        </text>
      </g>
    `;
    })
    .join("");

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        @import url('https://assets.p0web.com/Gerstner-ProgrammMedium.woff2');
        @import url('https://assets.p0web.com/FTSystemMono-Medium.woff2');
        .gerstner { font-family: 'Gerstner Programm', system-ui, sans-serif; }
        .ft-mono { font-family: 'FT System Mono', monospace; }
      </style>
    </defs>
    
    <!-- Background -->
    <rect width="1200" height="630" fill="#fcfcfa"/>
    
    <!-- Large company logo - top left -->
    <g transform="translate(120, 120)">
      <circle cx="0" cy="0" r="80" fill="#d8d0bf" opacity="0.3"/>
      <image x="-60" y="-60" width="120" height="120" 
             href="https://www.google.com/s2/favicons?domain=${encodeURIComponent(
               hostname
             )}&amp;sz=128" 
             opacity="0.9"/>
    </g>
    
    <!-- Title and subtitle beside logo -->
    <g transform="translate(240, 80)">
      <text x="0" y="0" class="gerstner" font-size="52" font-weight="500" fill="#1d1b16">
        Competitor Analysis
      </text>
      <text x="0" y="80" class="ft-mono" font-size="36" font-weight="400" fill="#fb631b">
        ${escapeXml(companyName)}
      </text>
    </g>
    
    <!-- Neural line decoration -->
    <line x1="120" y1="280" x2="1080" y2="280" stroke="#d8d0bf" stroke-width="2" opacity="0.6"/>
    
    <!-- Competitors label -->
    <text x="600" y="360" text-anchor="middle" class="ft-mono" font-size="18" font-weight="500" fill="#1d1b16" opacity="0.7">
      KEY COMPETITORS
    </text>
    
    <!-- Competitor logos spread across full width -->
    ${competitorLogos}
    
    <!-- Domain at bottom -->
    <text x="600" y="590" text-anchor="middle" class="ft-mono" font-size="16" fill="#1d1b16" opacity="0.5">
      ${escapeXml(hostname)}
    </text>
  </svg>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const hostname = company.trim().toLowerCase();

  const existingAnalysis = await do_stub.getAnalysis(hostname);
  if (existingAnalysis) {
    // Check if analysis is older than 14 days
    if (isAnalysisOld(existingAnalysis.created_at) && !!ctx.authenticated) {
      // Delete old analysis and create new one
      await do_stub.deleteAnalysis(hostname);
    } else if (!!existingAnalysis.error) {
      // Delete old analysis and create new one
      await do_stub.deleteAnalysis(hostname);
    } else {
      // Redirect to existing analysis
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/analysis/${hostname}`,
        },
      });
    }
  }

  // Validate hostname
  const isValid = await isValidHostname(hostname);
  if (!isValid) {
    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invalid Domain - Competitor Analysis</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body { font-family: 'system-ui', sans-serif; }
        </style>
      </head>
      <body class="min-h-screen bg-gray-50 flex items-center justify-center">
        <div class="max-w-lg mx-auto text-center p-8">
          <div class="w-16 h-16 mx-auto mb-6 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-gray-900 mb-4">Invalid Domain</h1>
          <p class="text-gray-600 mb-6">
            <strong>${escapeHtml(
              hostname
            )}</strong> doesn't appear to be a valid or accessible domain. 
            Please check the spelling and make sure the website exists.
          </p>
          <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-sm text-yellow-800">
            <div class="font-semibold mb-2">Tips:</div>
            <ul class="text-left space-y-1">
              <li>• Make sure to include the full domain (e.g., example.com)</li>
              <li>• Don't include http:// or https://</li>
              <li>• Check that the website is actually accessible</li>
            </ul>
          </div>
          <a href="/" class="inline-block bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
            ← Try Again
          </a>
        </div>
      </body>
      </html>
    `,
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  if (!ctx.authenticated) {
    // Show login dialog instead of direct redirect
    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login Required - Competitor Analysis</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body { font-family: 'system-ui', sans-serif; }
        </style>
      </head>
      <body class="min-h-screen bg-gray-50 flex items-center justify-center">
        <div class="max-w-lg mx-auto text-center p-8">
          <div class="w-16 h-16 mx-auto mb-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/>
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-gray-900 mb-4">Login Required</h1>
          <p class="text-gray-600 mb-2">
            To analyze <strong>${escapeHtml(
              company
            )}</strong>, we need to use AI research tools on your behalf.
          </p>
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6 text-sm text-blue-800">
            <div class="font-semibold mb-2">What you get:</div>
            <ul class="text-left space-y-1">
              <li>• 5 free competitive analyses</li>
              <li>• AI-powered market research</li>
              <li>• Reddit community insights</li>
              <li>• Comprehensive competitor profiles</li>
            </ul>
          </div>
          <p class="text-xs text-gray-500 mb-6">
            We use your profile to personalize the experience and track your usage limits.
          </p>
          <a href="/authorize?redirect_to=${encodeURIComponent(
            url.pathname + url.search
          )}" 
             class="inline-block bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
            🚀 Login with X
          </a>
          <div class="mt-6">
            <a href="/" class="text-sm text-gray-500 hover:text-gray-700 underline">
              ← Back to home
            </a>
          </div>
        </div>
      </body>
      </html>
    `,
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  const companyName = getCompanyName(hostname);

  // Check user limits
  const userAnalyses = await do_stub.getUserAnalysisCount(ctx.user?.username);
  if (userAnalyses >= 5 && ctx.user.username !== ADMIN_USERNAME) {
    return new Response(
      "Maximum of 5 analyses allowed per user. Host it yourself if you need more! \n\nhttps://github.com/janwilmake/competitor-analysis",
      { status: 429 }
    );
  }

  // Create analysis task
  const parallel = new Parallel({ apiKey: env.PARALLEL_API_KEY });

  try {
    const taskRun = await parallel.beta.taskRun.create(
      {
        input: `Conduct comprehensive competitive intelligence analysis for company: ${hostname} including a Reddit sentiment analysis`,
        processor: "pro",
        metadata: { hostname },
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
                "executive_summary",
              ],
              additionalProperties: false,
              properties: {
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
                    "Primary industry sector and specific vertical with market context. 2-5 words.",
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
                business_description: {
                  type: "string",
                  description:
                    "Comprehensive 2-3 paragraph description of the company's core business, products, services, target customers, and revenue model. Include specific product names and key differentiators.",
                },
                unique_value_proposition: {
                  type: "string",
                  description:
                    "Clear statement of what makes this company unique in the market",
                },
                target_market_analysis: {
                  type: "string",
                  description:
                    "1-2 paragraph analysis of the company's target market segments, customer demographics, geographic focus, and market positioning strategy.",
                },
                recent_news_developments: {
                  type: "string",
                  description:
                    "Summary of significant company developments, product launches, partnerships, leadership changes, or strategic moves from the last 6-12 months with specific dates and details.",
                },
                market_size_and_growth: {
                  type: "string",
                  description:
                    "Detailed analysis of the total addressable market size, growth rates, key market drivers, and future projections for the industry the company operates in.",
                },

                competitors: {
                  type: "array",
                  description: "3-6 key direct competitors.",
                  items: {
                    type: "object",
                    required: ["name", "website"],
                    additionalProperties: false,
                    properties: {
                      name: {
                        type: "string",
                        description: "Competitor company name",
                      },
                      website: {
                        type: "string",
                        description:
                          "Competitor website URL. Leave empty if not found",
                      },
                    },
                  },
                },

                competitive_landscape_overview: {
                  type: "string",
                  description:
                    "Short summary (1 paragraph) of the competitive landscape and market dynamics",
                },

                target_company_reddit_analysis: {
                  type: "string",
                  description:
                    "Comprehensive paragraph analysis of Reddit discussions specifically about the target company, including common themes, user experiences, comparisons to competitors, and insights from relevant subreddits.",
                },

                reddit_overall_sentiment: {
                  type: "string",
                  description:
                    "Overall sentiment of the target company on Reddit: 'low', 'medium' or 'high'",
                },
                market_opportunities: {
                  type: "string",
                  description:
                    "2-3 sentences analysis of underserved market segments, emerging trends, geographic expansion opportunities, or product/service gaps that represent growth opportunities for the target company.",
                },
                executive_summary: {
                  type: "string",
                  description:
                    "Short (1 paragraph) executive summary covering the company's current market position, key competitive dynamics, most significant opportunities and threats, and critical strategic implications. Written for senior leadership decision-making.",
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
      hostname,
      company_domain: hostname,
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
      headers: { Location: `/analysis/${hostname}` },
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
    const hostname = payload.data.metadata?.hostname;
    if (!hostname) {
      return new Response("Missing hostname in metadata", { status: 400 });
    }

    try {
      const parallel = new Parallel({ apiKey: env.PARALLEL_API_KEY });
      const result = await parallel.beta.taskRun.result(payload.data.run_id);

      const hasEmptyString = result.output.content
        ? !!Object.values(result.output.content).find((x) => x === "")
        : true;

      const hasNoCompetitors =
        typeof result.output.content === "object"
          ? !(result.output.content.competitors as any[])?.length
          : true;

      if (result.output.type !== "json") {
        await do_stub.updateAnalysisResult(
          hostname,
          null,
          "Unexpected output format"
        );
      } else if (hasEmptyString) {
        await do_stub.updateAnalysisResult(
          hostname,
          JSON.stringify(result),
          "Could not complete task - outputs contained empty strings. Please try again."
        );
      } else if (hasNoCompetitors) {
        await do_stub.updateAnalysisResult(
          hostname,
          JSON.stringify(result),
          "Could not complete task - No competitors found. Please try again."
        );
      } else {
        await do_stub.updateAnalysisResult(
          hostname,
          JSON.stringify(result),
          null
        );
      }
    } catch (error) {
      console.error("Error fetching result:", error);
      await do_stub.updateAnalysisResult(
        hostname,
        null,
        "Error fetching result"
      );
    }
  } else if (
    payload.type === "task_run.status" &&
    payload.data.status === "failed"
  ) {
    const hostname = payload.data.metadata?.hostname;
    if (hostname) {
      await do_stub.updateAnalysisResult(
        hostname,
        null,
        payload.data.error?.message || "Analysis failed"
      );
    }
  }

  return new Response("OK");
}

async function handleResult(
  url: URL,
  hostname: string,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const analysis = await do_stub.getAnalysis(hostname);

  if (!analysis) {
    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Analysis Not Found - ${escapeHtml(hostname)}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body { font-family: 'system-ui', sans-serif; }
        </style>
      </head>
      <body class="min-h-screen bg-gray-50 flex items-center justify-center">
        <div class="max-w-md mx-auto text-center p-8">
          <div class="w-16 h-16 mx-auto mb-6 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/>
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-gray-900 mb-4">Analysis Not Found</h1>
          <p class="text-gray-600 mb-6">
            We haven't analyzed <strong>${escapeHtml(hostname)}</strong> yet. 
            Would you like to start a competitive analysis for this company?
          </p>
          <a href="/new?company=${encodeURIComponent(hostname)}" 
             class="inline-block bg-gradient-to-r from-orange-500 to-red-500 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
            🔍 Analyze ${escapeHtml(hostname)}
          </a>
          <div class="mt-6">
            <a href="/" class="text-sm text-gray-500 hover:text-gray-700 underline">
              ← Back to all analyses
            </a>
          </div>
        </div>
      </body>
      </html>
    `,
      {
        status: 404,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  // If there's an error, show error page instead of the result
  if (analysis.error) {
    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Analysis Error - ${escapeHtml(analysis.company_name)}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body { font-family: 'system-ui', sans-serif; }
        </style>
      </head>
      <body class="min-h-screen bg-gray-50 flex items-center justify-center">
        <div class="max-w-lg mx-auto text-center p-8">
          <div class="w-16 h-16 mx-auto mb-6 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-gray-900 mb-4">Analysis Failed</h1>
          <p class="text-gray-600 mb-2">
            We encountered an issue while analyzing <strong>${escapeHtml(
              analysis.company_name
            )}</strong>:
          </p>
          <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-800">
            ${escapeHtml(analysis.error)}
          </div>
          <div class="space-y-3">
            <a href="/new?company=${encodeURIComponent(hostname)}" 
               class="inline-block bg-gradient-to-r from-orange-500 to-red-500 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
              🔄 Try Again
            </a>
            <div>
              <a href="/" class="text-sm text-gray-500 hover:text-gray-700 underline">
                ← Back to all analyses
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  if (analysis.status === "done" && !analysis.error) {
    await do_stub.incrementVisits(hostname);
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

  //https://svg.quickog.com/competitors.p0web.com/og/cloudflare.com
  const metaTags = `
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="competitive analysis, market research, ${escapeHtml(
    analysis.company_name
  )}, competitors, business intelligence">
  <meta name="author" content="Competitor Analysis">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url.origin}/analysis/${hostname}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="https://svg.quickog.com/competitors.p0web.com/og/${hostname}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(pageTitle)}">
  <meta property="og:site_name" content="Competitor Analysis">
  
  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="${url.origin}/analysis/${hostname}">
  <meta property="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta property="twitter:description" content="${escapeHtml(description)}">
  <meta property="twitter:image" content="https://svg.quickog.com/competitors.p0web.com/og/${hostname}">
  <meta property="twitter:image:alt" content="${escapeHtml(pageTitle)}">
  
  <!-- Additional SEO -->
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${url.origin}/analysis/${hostname}">
`;

  html = html.replace("</head>", `${metaTags}</head>`);

  // Inject dynamic data
  const result = analysis.result ? JSON.parse(analysis.result) : null;

  const data = {
    analysis: {
      ...analysis,
      result,
    },
    isOld: isAnalysisOld(analysis.created_at),
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
    // Update table to use hostname instead of slug
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        hostname TEXT PRIMARY KEY,
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
      INSERT INTO analyses (hostname, company_domain, company_name, status, username, profile_image_url, created_at, updated_at, visits, result, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      analysis.hostname,
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

  async getAnalysis(hostname: string): Promise<AnalysisRow | null> {
    const results = this.sql.exec(
      "SELECT * FROM analyses WHERE hostname = ?",
      hostname
    );
    const rows = results.toArray();
    return rows.length > 0 ? (rows[0] as AnalysisRow) : null;
  }

  async deleteAnalysis(hostname: string): Promise<void> {
    this.sql.exec("DELETE FROM analyses WHERE hostname = ?", hostname);
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
    hostname: string,
    result: string | null,
    error: string | null
  ): Promise<void> {
    const status = "done"; // Both success and error are considered "done"
    this.sql.exec(
      `
      UPDATE analyses 
      SET status = ?, result = ?, error = ?, updated_at = ?
      WHERE hostname = ?
    `,
      status,
      result,
      error,
      new Date().toISOString(),
      hostname
    );
  }

  async incrementVisits(hostname: string): Promise<void> {
    this.sql.exec(
      "UPDATE analyses SET visits = visits + 1 WHERE hostname = ?",
      hostname
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
