/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />
import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { withMcp } from "with-mcp";
//@ts-ignore
import openapi from "./public/openapi.json";
import { DurableObject } from "cloudflare:workers";
import { UserContext, withSimplerAuth } from "simplerauth-client";
import { Parallel } from "parallel-web";
//@ts-ignore
import json_schema from "./public/task.schema.json";
//@ts-ignore
import indexHtml from "./index.html";
//@ts-ignore
import resultHtml from "./result.html";
const ANALYSIS_LIMIT = 5;
const DO_NAME = "v5";
const ADMIN_USERNAMES = ["janwilmake", "khushi_shelat"];
const NEW_VERSION_DATE = 1757517150949;

export interface Env {
  COMPETITOR_ANALYSIS: DurableObjectNamespace<
    CompetitorAnalysisDO & QueryableHandler
  >;
  PARALLEL_API_KEY: string;
  PARALLEL_WEBHOOK_SECRET: string;
  MCP_URL: string;
}

interface AnalysisRow {
  hostname: string;
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
  // New fields
  category: string | null;
  business_description: string | null;
  industry_sector: string | null;
  keywords: string | null;
}

function getCompanyName(domain: string): string {
  // Remove protocol if present
  let cleanDomain = domain.replace(/^https?:\/\//, "");

  // Remove www. if present
  cleanDomain = cleanDomain.replace(/^www\./, "");

  // Remove TLD (everything after the last dot)
  const lastDotIndex = cleanDomain.lastIndexOf(".");
  if (lastDotIndex > 0) {
    cleanDomain = cleanDomain.substring(0, lastDotIndex);
  }

  // Replace dots with spaces and capitalize first letter of each word
  return cleanDomain
    .split(".")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

  if (createdDate.valueOf() < NEW_VERSION_DATE) {
    // it's old because we have a newer version since.
    return true;
  }

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
    const handler = withSimplerAuth<Env>(
      async (request, env, ctx) => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        const do_id = env.COMPETITOR_ANALYSIS.idFromName(DO_NAME);
        const do_stub = env.COMPETITOR_ANALYSIS.get(do_id);

        switch (pathname) {
          case "/admin": {
            if (!ADMIN_USERNAMES.includes(ctx.user?.username || "")) {
              return new Response("Admin only", { status: 401 });
            }
            return studioMiddleware(request, do_stub.raw, {
              dangerouslyDisableAuth: true,
            });
          }
          case "/import": {
            if (!ADMIN_USERNAMES.includes(ctx.user?.username || "")) {
              return new Response("Admin only", { status: 401 });
            }
          }

          case "/":
            return handleHome(do_stub);

          case "/new":
            return handleNew(request, do_stub, ctx, env);

          case "/webhook":
            return handleWebhook(request, do_stub, env);

          case "/dump": {
            return handleDump(request, do_stub);
          }

          default:
            if (pathname.startsWith("/analysis/")) {
              const hostname = pathname.replace("/analysis/", "");
              return handleResult(url, hostname, do_stub);
            }
            if (pathname.startsWith("/md/")) {
              const hostname = pathname.replace("/md/", "");
              return handleMd(request, hostname, do_stub);
            }
            if (pathname.startsWith("/og/")) {
              const hostname = pathname.replace("/og/", "");
              return handleOg(hostname, do_stub);
            }
            if (pathname.startsWith("/search/")) {
              return handleSearch(pathname, do_stub);
            }
            return handle404();
        }
      },
      { isLoginRequired: false }
    );

    return withMcp(handler, openapi, {
      serverInfo: { name: "Competitive Analysis MCP", version: "1.0.0" },
      toolOperationIds: ["getAnalysisMarkdown"],
    })(request, env, ctx);
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
            ${
              analysis.business_description
                ? escapeHtml(
                    analysis.business_description.length > 120
                      ? analysis.business_description.substring(0, 120) + "..."
                      : analysis.business_description
                  )
                : "Competitive analysis with market insights and Reddit community opinions"
            }
          </p>
          <div class="flex items-center justify-between text-xs text-gray-500">
            <span>${analysis.category || "📊 Analysis available"}</span>
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
  competitors: Array<{ name: string; hostname: string }>
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
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
        competitor.hostname
      )}&amp;sz=64`;

      return `
      <g transform="translate(${x}, 480)">
        <!-- Background circle -->
        <circle cx="0" cy="0" r="40" fill="#d8d0bf" opacity="0.2"/>
        <image x="-30" y="-30" width="60" height="60" href="${faviconUrl}" opacity="0.9"/>
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

async function handleMd(
  request: Request,
  hostname: string,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const analysis = await do_stub.getAnalysis(hostname);
  const url = new URL(request.url);
  if (
    !analysis ||
    analysis.status !== "done" ||
    analysis.error ||
    !analysis.result
  ) {
    return new Response(
      `Analysis not found. Please go to ${url.origin}/new?company=${hostname} to add this company.`,
      { status: 404 }
    );
  }

  const result = JSON.parse(analysis.result);
  const primaryData = result.output?.content || {};

  // Get competitor hostnames directly from the analysis
  const competitors = primaryData.competitors || [];
  const competitorHostnames = competitors
    .map((comp: { hostname: string }) => comp.hostname)
    .filter(Boolean);

  // Fetch all competitor analyses
  const competitorAnalyses = await Promise.all(
    competitorHostnames.map(async (compHostname: string) => {
      const compAnalysis = await do_stub.getAnalysis(compHostname);
      if (
        compAnalysis &&
        compAnalysis.status === "done" &&
        !compAnalysis.error &&
        compAnalysis.result
      ) {
        const compResult = JSON.parse(compAnalysis.result);
        return {
          hostname: compHostname,
          company_name: compAnalysis.company_name,
          data: compResult.output?.content || {},
        };
      }
      return null;
    })
  );

  const validCompetitorAnalyses = competitorAnalyses.filter(Boolean);

  // Build comprehensive markdown report
  const markdown = buildComprehensiveCompetitiveReport(
    { hostname, company_name: analysis.company_name, data: primaryData },
    validCompetitorAnalyses
  );

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown;charset=utf8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function buildComprehensiveCompetitiveReport(
  primaryCompany: { hostname: string; company_name: string; data: any },
  competitors: Array<{ hostname: string; company_name: string; data: any }>
): string {
  const allCompanies = [primaryCompany, ...competitors];

  let markdown = `# Comprehensive Competitive Intelligence Report\n\n`;
  markdown += `**Primary Company:** ${
    primaryCompany.company_name || primaryCompany.hostname
  }\n`;
  markdown += `**Domain:** ${
    primaryCompany.data.company_domain || primaryCompany.hostname
  }\n`;
  markdown += `**Analysis Date:** ${new Date().toLocaleDateString()}\n`;
  markdown += `**Companies Analyzed:** ${allCompanies.length} (${primaryCompany.company_name} + ${competitors.length} competitors)\n\n`;

  markdown += `---\n\n`;

  // Executive Summary
  if (primaryCompany.data.executive_summary) {
    markdown += `## Executive Summary\n\n`;
    markdown += `${primaryCompany.data.executive_summary}\n\n`;
    markdown += `---\n\n`;
  }

  // Company Overview Section - side by side comparison
  markdown += `## Company Overview Comparison\n\n`;

  // Business Description
  markdown += `### Business Description\n\n`;
  allCompanies.forEach((company) => {
    if (company.data.business_description) {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `**${indicator}${company.company_name}:** ${company.data.business_description}\n\n`;
    }
  });

  // Unique Value Propositions
  const companiesWithUVP = allCompanies.filter(
    (c) => c.data.unique_value_proposition
  );
  if (companiesWithUVP.length > 0) {
    markdown += `### Unique Value Propositions\n\n`;
    companiesWithUVP.forEach((company) => {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `**${indicator}${company.company_name}:** ${company.data.unique_value_proposition}\n\n`;
    });
  }

  // Company Details Comparison Table
  markdown += `### Company Details Comparison\n\n`;

  const detailFields = [
    { key: "category", label: "Category" },
    { key: "industry_sector", label: "Industry Sector" },
    { key: "founded_year", label: "Founded" },
    { key: "employee_count", label: "Employees" },
    { key: "headquarters_location", label: "Headquarters" },
    { key: "total_funding_raised", label: "Funding" },
    { key: "current_valuation", label: "Valuation" },
  ];

  // Build header
  markdown += `| Field | ${allCompanies
    .map((c) =>
      c === primaryCompany ? `🎯 **${c.company_name}**` : c.company_name
    )
    .join(" | ")} |\n`;
  markdown += `|-------|${allCompanies.map(() => "-------").join("|")}|\n`;

  // Build rows
  detailFields.forEach((field) => {
    const hasData = allCompanies.some(
      (c) =>
        c.data[field.key] &&
        c.data[field.key] !== "Not found" &&
        c.data[field.key] !== "Not disclosed" &&
        c.data[field.key] !== "Not publicly disclosed"
    );
    if (hasData) {
      markdown += `| **${field.label}** | ${allCompanies
        .map((c) => {
          const value = c.data[field.key];
          if (
            !value ||
            value === "Not found" ||
            value === "Not disclosed" ||
            value === "Not publicly disclosed"
          ) {
            return "N/A";
          }
          return value;
        })
        .join(" | ")} |\n`;
    }
  });

  markdown += `\n`;

  // Investment & Funding Comparison
  const companiesWithFunding = allCompanies.filter(
    (c) =>
      (c.data.total_funding_raised &&
        c.data.total_funding_raised !== "Not disclosed") ||
      (c.data.current_valuation &&
        c.data.current_valuation !== "Not publicly disclosed") ||
      c.data.investment_summary
  );

  if (companiesWithFunding.length > 0) {
    markdown += `## Investment & Funding Analysis\n\n`;
    companiesWithFunding.forEach((company) => {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `### ${indicator}${company.company_name}\n\n`;

      if (
        company.data.total_funding_raised &&
        company.data.total_funding_raised !== "Not disclosed"
      ) {
        markdown += `**Total Funding:** ${company.data.total_funding_raised}\n\n`;
      }

      if (
        company.data.current_valuation &&
        company.data.current_valuation !== "Not publicly disclosed"
      ) {
        markdown += `**Valuation:** ${company.data.current_valuation}\n\n`;
      }

      if (company.data.latest_funding_round) {
        markdown += `**Latest Round:** ${company.data.latest_funding_round}\n\n`;
      }

      if (company.data.investment_summary) {
        markdown += `${company.data.investment_summary}\n\n`;
      }
    });
  }

  // Market Analysis Comparison
  const companiesWithMarketData = allCompanies.filter(
    (c) =>
      c.data.market_size_and_growth ||
      c.data.target_market_analysis ||
      c.data.market_opportunities
  );

  if (companiesWithMarketData.length > 0) {
    markdown += `## Market Analysis Comparison\n\n`;

    // Market Size & Growth
    const companiesWithMarketSize = companiesWithMarketData.filter(
      (c) => c.data.market_size_and_growth
    );
    if (companiesWithMarketSize.length > 0) {
      markdown += `### Market Size & Growth Analysis\n\n`;
      companiesWithMarketSize.forEach((company) => {
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `**${indicator}${company.company_name}:** ${company.data.market_size_and_growth}\n\n`;
      });
    }

    // Target Market Analysis
    const companiesWithTargetMarket = companiesWithMarketData.filter(
      (c) => c.data.target_market_analysis
    );
    if (companiesWithTargetMarket.length > 0) {
      markdown += `### Target Market Analysis\n\n`;
      companiesWithTargetMarket.forEach((company) => {
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `**${indicator}${company.company_name}:** ${company.data.target_market_analysis}\n\n`;
      });
    }

    // Market Opportunities
    const companiesWithOpportunities = companiesWithMarketData.filter(
      (c) => c.data.market_opportunities
    );
    if (companiesWithOpportunities.length > 0) {
      markdown += `### Market Opportunities\n\n`;
      companiesWithOpportunities.forEach((company) => {
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `**${indicator}${company.company_name}:** ${company.data.market_opportunities}\n\n`;
      });
    }
  }

  // Competitive Landscape
  if (primaryCompany.data.competitive_landscape_overview) {
    markdown += `## Competitive Landscape Overview\n\n`;
    markdown += `${primaryCompany.data.competitive_landscape_overview}\n\n`;
  }

  // Products & Features Comparison
  const companiesWithProducts = allCompanies.filter(
    (c) => c.data.products_summary
  );
  if (companiesWithProducts.length > 0) {
    markdown += `## Products & Features Analysis\n\n`;
    companiesWithProducts.forEach((company) => {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `### ${indicator}${company.company_name}\n\n`;
      markdown += `${company.data.products_summary}\n\n`;
    });
  }

  // Pricing Comparison
  const companiesWithPricing = allCompanies.filter(
    (c) => c.data.pricing_summary
  );
  if (companiesWithPricing.length > 0) {
    markdown += `## Pricing Analysis\n\n`;
    companiesWithPricing.forEach((company) => {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `### ${indicator}${company.company_name}\n\n`;
      markdown += `${company.data.pricing_summary}\n\n`;
    });
  }

  // Recent Developments Comparison
  const companiesWithNews = allCompanies.filter(
    (c) => c.data.recent_news_developments
  );
  if (companiesWithNews.length > 0) {
    markdown += `## Recent Developments\n\n`;
    companiesWithNews.forEach((company) => {
      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `### ${indicator}${company.company_name}\n\n`;
      markdown += `${company.data.recent_news_developments}\n\n`;
    });
  }

  // Reddit Community Insights Comparison
  const companiesWithReddit = allCompanies.filter(
    (c) => c.data.target_company_reddit_analysis
  );
  if (companiesWithReddit.length > 0) {
    markdown += `## Reddit Community Insights Comparison\n\n`;

    companiesWithReddit.forEach((company) => {
      const sentiment = company.data.reddit_overall_sentiment || "unknown";
      const sentimentEmoji =
        sentiment === "high"
          ? "😊"
          : sentiment === "medium"
          ? "😐"
          : sentiment === "low"
          ? "😞"
          : "❓";

      const indicator = company === primaryCompany ? "🎯 " : "";
      markdown += `### ${indicator}${company.company_name} ${sentimentEmoji} (${sentiment} sentiment)\n\n`;
      markdown += `${company.data.target_company_reddit_analysis}\n\n`;
    });

    // Reddit Sentiment Summary Table
    if (companiesWithReddit.length > 1) {
      markdown += `### Reddit Sentiment Summary\n\n`;
      markdown += `| Company | Sentiment | Analysis Available |\n`;
      markdown += `|---------|-----------|-------------------|\n`;
      companiesWithReddit.forEach((company) => {
        const sentiment = company.data.reddit_overall_sentiment || "Unknown";
        const sentimentEmoji =
          sentiment === "high"
            ? "😊"
            : sentiment === "medium"
            ? "😐"
            : sentiment === "low"
            ? "😞"
            : "❓";
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `| ${indicator}${company.company_name} | ${sentimentEmoji} ${sentiment} | ✅ |\n`;
      });
      markdown += `\n`;
    }
  }

  // Cross-Company Strategic Analysis
  if (allCompanies.length > 1) {
    markdown += `## Cross-Company Strategic Analysis\n\n`;

    markdown += `### Key Differentiators\n\n`;
    allCompanies.forEach((company) => {
      if (company.data.unique_value_proposition) {
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `**${indicator}${
          company.company_name
        }:** Focus on ${company.data.unique_value_proposition.toLowerCase()}\n\n`;
      }
    });

    // Competitive Positioning
    markdown += `### Competitive Positioning\n\n`;
    markdown += `Based on the analysis of ${allCompanies.length} companies:\n\n`;

    // Funding comparison
    const fundedCompanies = allCompanies.filter(
      (c) =>
        c.data.total_funding_raised &&
        c.data.total_funding_raised !== "Not disclosed"
    );
    if (fundedCompanies.length > 1) {
      markdown += `**Funding Landscape:**\n`;
      fundedCompanies
        .sort((a, b) => {
          // Simple comparison - companies with higher funding mentioned first
          const aFunding = a.data.total_funding_raised || "";
          const bFunding = b.data.total_funding_raised || "";
          return bFunding.localeCompare(aFunding);
        })
        .forEach((company) => {
          const indicator = company === primaryCompany ? "🎯 " : "";
          markdown += `• ${indicator}${company.company_name}: ${company.data.total_funding_raised}\n`;
        });
      markdown += `\n`;
    }

    // Employee count comparison
    const companiesWithEmployees = allCompanies.filter(
      (c) => c.data.employee_count && c.data.employee_count !== "Not found"
    );
    if (companiesWithEmployees.length > 1) {
      markdown += `**Company Size:**\n`;
      companiesWithEmployees.forEach((company) => {
        const indicator = company === primaryCompany ? "🎯 " : "";
        markdown += `• ${indicator}${company.company_name}: ${company.data.employee_count} employees\n`;
      });
      markdown += `\n`;
    }
  }

  // Strategic Recommendations for Primary Company
  markdown += `## Strategic Implications for ${primaryCompany.company_name}\n\n`;

  markdown += `### Competitive Intelligence Summary\n\n`;
  markdown += `• **Market Position:** Competing against ${competitors.length} analyzed competitors\n`;

  if (primaryCompany.data.reddit_overall_sentiment) {
    markdown += `• **Community Sentiment:** ${
      primaryCompany.data.reddit_overall_sentiment.charAt(0).toUpperCase() +
      primaryCompany.data.reddit_overall_sentiment.slice(1)
    } sentiment on Reddit\n`;
  }

  if (primaryCompany.data.unique_value_proposition) {
    markdown += `• **Key Differentiator:** ${primaryCompany.data.unique_value_proposition}\n`;
  }

  // Compare against competitors
  if (competitors.length > 0) {
    const competitorSentiments = competitors
      .filter((c) => c.data.reddit_overall_sentiment)
      .map((c) => c.data.reddit_overall_sentiment);

    if (competitorSentiments.length > 0) {
      const avgSentiment =
        competitorSentiments.reduce((acc, sentiment) => {
          if (sentiment === "high") return acc + 3;
          if (sentiment === "medium") return acc + 2;
          if (sentiment === "low") return acc + 1;
          return acc;
        }, 0) / competitorSentiments.length;

      const primarySentimentScore =
        primaryCompany.data.reddit_overall_sentiment === "high"
          ? 3
          : primaryCompany.data.reddit_overall_sentiment === "medium"
          ? 2
          : primaryCompany.data.reddit_overall_sentiment === "low"
          ? 1
          : 0;

      if (primarySentimentScore > avgSentiment) {
        markdown += `• **Sentiment Advantage:** Higher community sentiment than competitor average\n`;
      } else if (primarySentimentScore < avgSentiment) {
        markdown += `• **Sentiment Opportunity:** Room to improve community perception relative to competitors\n`;
      }
    }
  }

  markdown += `\n### Recommendations\n\n`;
  markdown += `1. **Monitor Competitive Developments:** Keep tracking the ${competitors.length} identified competitors for strategic changes\n`;
  markdown += `2. **Leverage Unique Positioning:** Continue to emphasize differentiation in market communications\n`;
  markdown += `3. **Community Engagement:** ${
    primaryCompany.data.reddit_overall_sentiment === "high"
      ? "Maintain"
      : "Improve"
  } Reddit and social media presence\n`;
  markdown += `4. **Regular Analysis:** Update this competitive analysis quarterly to track market shifts\n\n`;

  // Footer
  markdown += `---\n\n`;
  markdown += `*Comprehensive competitive intelligence report generated on ${new Date().toLocaleDateString()}*\n\n`;
  markdown += `**Data Sources:** ${allCompanies.length} company analyses including AI-powered research, Reddit sentiment analysis, and public market data\n\n`;
  markdown += `**Coverage:** ${
    primaryCompany.company_name
  } (primary) + ${competitors.map((c) => c.company_name).join(", ")}\n\n`;
  markdown += `*For the most current information, please verify directly with company sources and consider conducting follow-up research.*\n`;

  return markdown;
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
              <li>• 1 free competitive analysis</li>
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

  // Check user limits
  const userAnalyses = await do_stub.getUserAnalysisCount(ctx.user?.username);
  if (
    userAnalyses >= ANALYSIS_LIMIT &&
    !ADMIN_USERNAMES.includes(ctx.user?.username || "")
  ) {
    return new Response(
      `Maximum of ${ANALYSIS_LIMIT} analyses allowed per user. Host it yourself if you need more! \n\nhttps://github.com/janwilmake/competitor-analysis`,
      { status: 429 }
    );
  }

  // Create analysis task

  try {
    await performAnalysis(env, do_stub, {
      hostname,
      isDeep: true,
      url,
      username: ctx.user?.username,
      profile_image_url: ctx.user?.profile_image_url,
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

const performAnalysis = async (
  env: Env,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>,
  context: {
    hostname: string;
    isDeep: boolean;
    url: URL;
    username: string;
    profile_image_url: string;
  }
) => {
  const { hostname, isDeep, url, username, profile_image_url } = context;
  const parallel = new Parallel({ apiKey: env.PARALLEL_API_KEY });

  const companyName = getCompanyName(hostname);
  const taskRun = await parallel.beta.taskRun.create(
    {
      input: `Conduct comprehensive competitive intelligence analysis for company: ${hostname} including a Reddit sentiment analysis`,
      processor: "ultra8x",
      metadata: { hostname, isDeep, username, profile_image_url },
      mcp_servers: [{ name: "Reddit", url: env.MCP_URL, type: "url" }],
      webhook: {
        url: `${url.protocol}//${url.host}/webhook`,
        event_types: ["task_run.status"],
      },
      task_spec: { output_schema: { type: "json", json_schema } },
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
    username: username || "",
    profile_image_url: profile_image_url || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    visits: 0,
    result: null,
    error: null,
    category: null,
    business_description: null,
    industry_sector: null,
    keywords: null,
  });
};

async function handleWebhook(
  request: Request,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
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
      const result = await parallel.beta.taskRun.result(payload.data.run_id, {
        betas: ["mcp-server-2025-07-17"],
      });

      const analysisData = result.output?.content || {};

      // Check if company_fits_criteria is false
      if (analysisData.company_fits_criteria === false) {
        await do_stub.updateAnalysisResult(
          hostname,
          null,
          "This domain does not appear to be an active company with real products or services. Please try a different company."
        );
        return new Response("OK");
      }

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
        // } else if (hasNoCompetitors) {
        //   await do_stub.updateAnalysisResult(
        //     hostname,
        //     JSON.stringify(result),
        //     "Could not complete task - No competitors found. Please try again."
        //   );
      } else {
        // it's good - update the analysis with all the new fields
        const updateData = {
          company_name: analysisData.company_name || null,
          category: analysisData.category || null,
          business_description: analysisData.business_description || null,
          industry_sector: analysisData.industry_sector || null,
          keywords: analysisData.keywords || null,
        };

        if (result.run.metadata?.isDeep) {
          // perform deeper analysis too - now using hostname directly
          const competitors = result.output.content?.competitors as
            | any[]
            | undefined;
          const hostnames = competitors
            ?.map((comp: { hostname: string }) => comp.hostname)
            .filter(Boolean);

          if (hostnames?.length) {
            const username = result.run.metadata.username as string | undefined;
            const profile_image_url = result.run.metadata.profile_image_url as
              | string
              | undefined;

            await Promise.all(
              hostnames.map(async (hostname) => {
                // first check.
                const existingAnalysis = await do_stub.getAnalysis(hostname);

                if (
                  existingAnalysis &&
                  !existingAnalysis.error &&
                  !isAnalysisOld(existingAnalysis.updated_at)
                ) {
                  console.log("not needed", hostname);
                  // not needed if already have without error and not old
                  return;
                }

                console.log("needed deep", hostname);

                await performAnalysis(env, do_stub, {
                  isDeep: false,
                  hostname,
                  url,
                  username,
                  profile_image_url,
                });
              })
            );
          }
        }

        await do_stub.updateAnalysisResultWithData(
          hostname,
          JSON.stringify(result),
          null,
          updateData
        );
      }
    } catch (error) {
      console.error("Error fetching result: ", error);
      await do_stub.updateAnalysisResult(
        hostname,
        null,
        "Error fetching result: " + error?.message
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

async function handleSearch(
  pathname: string,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const query = decodeURIComponent(pathname.replace("/search/", ""));

  if (!query || query.trim().length === 0) {
    return new Response("Search query is required", { status: 400 });
  }

  const searchResults = await do_stub.searchAnalyses(query.trim());

  const createSearchCards = (analyses: AnalysisRow[]) => {
    if (analyses.length === 0) {
      return `<div class="text-center py-12">
        <div class="w-16 h-16 mx-auto mb-6 bg-gray-100 text-gray-600 rounded-full flex items-center justify-center">
          <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/>
          </svg>
        </div>
        <h3 class="text-xl font-bold text-gray-900 mb-4">No results found</h3>
        <p class="text-gray-500 text-lg">No analyses found for "${escapeHtml(
          query
        )}"</p>
        <div class="mt-6">
          <a href="/new?company=${encodeURIComponent(query)}" 
             class="inline-block bg-gradient-to-r from-orange-500 to-red-500 text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity">
            🔍 Analyze ${escapeHtml(query)}
          </a>
        </div>
      </div>`;
    }

    return analyses
      .map((analysis) => {
        const initial = analysis.company_name.charAt(0).toUpperCase();
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
          analysis.company_domain
        )}&sz=64`;

        const statusBadge = analysis.error
          ? '<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">Error</span>'
          : analysis.status === "pending"
          ? '<span class="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">Pending</span>'
          : '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Complete</span>';

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
            <div class="flex-1">
              <div class="flex items-center justify-between">
                <h4 class="font-semibold text-lg">${escapeHtml(
                  analysis.company_name
                )}</h4>
                ${statusBadge}
              </div>
              <p class="text-sm text-gray-500">${escapeHtml(
                analysis.company_domain
              )}</p>
            </div>
          </div>
          <p class="text-gray-600 text-sm mb-3">
            ${
              analysis.business_description
                ? escapeHtml(
                    analysis.business_description.length > 120
                      ? analysis.business_description.substring(0, 120) + "..."
                      : analysis.business_description
                  )
                : analysis.error
                ? `Analysis failed: ${escapeHtml(
                    analysis.error.substring(0, 100)
                  )}...`
                : analysis.status === "pending"
                ? "Analysis in progress..."
                : "Competitive analysis with market insights and Reddit community opinions"
            }
          </p>
          <div class="flex items-center justify-between text-xs text-gray-500">
            <span>${analysis.category || "📅"} ${new Date(
          analysis.created_at
        ).toLocaleDateString()}</span>
            <span>🔥 ${analysis.visits} views</span>
          </div>
        </div>
      `;
      })
      .join("");
  };

  const searchCards = createSearchCards(searchResults);

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Search Results: ${escapeHtml(
          query
        )} - Competitor Analysis</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @font-face {
                font-family: 'FT System Mono';
                src: url('https://assets.p0web.com/FTSystemMono-Regular.woff2') format('woff2');
                font-weight: 400;
                font-display: swap;
            }
            @font-face {
                font-family: 'FT System Mono';
                src: url('https://assets.p0web.com/FTSystemMono-Medium.woff2') format('woff2');
                font-weight: 500;
                font-display: swap;
            }
            @font-face {
                font-family: 'Gerstner Programm';
                src: url('https://assets.p0web.com/Gerstner-ProgrammRegular.woff2') format('woff2');
                font-weight: 400;
                font-display: swap;
            }
            @font-face {
                font-family: 'Gerstner Programm';
                src: url('https://assets.p0web.com/Gerstner-ProgrammMedium.woff2') format('woff2');
                font-weight: 500;
                font-display: swap;
            }
            :root {
                --off-white: #fcfcfa;
                --index-black: #1d1b16;
                --neural: #d8d0bf;
                --signal: #fb631b;
            }
            body {
                font-family: 'FT System Mono', monospace;
                background-color: var(--off-white);
                color: var(--index-black);
                line-height: 1.5;
                font-size: 14px;
            }
            .gerstner {
                font-family: 'Gerstner Programm', serif;
                line-height: 1.2;
            }
            .company-card {
                background: white;
                border: 2px solid #e8e6e1;
                border-radius: 4px;
                padding: 24px;
                cursor: pointer;
                transition: all 0.2s ease;
                position: relative;
                overflow: hidden;
            }
            .company-card:hover {
                border-color: var(--signal);
            }
            .company-logo {
                width: 48px;
                height: 48px;
                background: var(--signal);
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                color: white;
                font-size: 20px;
            }
            .company-logo-container {
                position: relative;
                width: 48px;
                height: 48px;
            }
            .search-input {
                width: 100%;
                padding: 12px 16px;
                border: 2px solid #e8e6e1;
                border-radius: 4px;
                font-size: 14px;
                transition: all 0.2s ease;
                background: white;
                font-family: 'FT System Mono', monospace;
            }
            .search-input:focus {
                outline: none;
                border-color: var(--signal);
            }
        </style>
    </head>
    <body class="min-h-screen">
        <!-- Header -->
        <header class="py-6 border-b-2 border-gray-200">
            <div class="max-w-6xl mx-auto px-6 flex items-center justify-between">
                <div class="flex items-center">
                    <a href="/" class="gerstner text-xl font-medium hover:text-gray-600">
                        Competitor Analysis
                    </a>
                </div>
                <p class="text-gray-600 text-sm uppercase tracking-wide">Search Results</p>
            </div>
        </header>

        <!-- Search Section -->
        <section class="py-8">
            <div class="max-w-6xl mx-auto px-6">
                <div class="max-w-2xl mx-auto mb-8">
                    <form action="/search/" method="get" onsubmit="event.preventDefault(); window.location.href='/search/' + encodeURIComponent(this.querySelector('input').value);">
                        <input type="text" 
                               class="search-input" 
                               placeholder="Search by company name, domain, or keywords..."
                               value="${escapeHtml(query)}"
                               autocomplete="off">
                    </form>
                </div>
                
                <div class="mb-6">
                    <h1 class="gerstner text-2xl font-medium mb-2">
                        Search Results for "${escapeHtml(query)}"
                    </h1>
                    <p class="text-gray-600 text-sm">
                        Found ${searchResults.length} result${
    searchResults.length === 1 ? "" : "s"
  }
                    </p>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    ${searchCards}
                </div>
            </div>
        </section>

        <!-- Footer -->
        <footer class="py-8 border-t-2 border-gray-200 mt-16">
            <div class="max-w-6xl mx-auto px-6 flex items-center justify-between">
                <div class="flex items-center space-x-4">
                    <a href="/" class="text-gray-600 text-xs uppercase tracking-wide hover:text-gray-800">← Back to Home</a>
                </div>
                <div class="text-gray-600 text-xs uppercase tracking-wide">
                    AI-powered market research
                </div>
            </div>
        </footer>
    </body>
    </html>
  `;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleDump(
  request: Request,
  do_stub: DurableObjectStub<CompetitorAnalysisDO>
): Promise<Response> {
  const url = new URL(request.url);
  const pageParam = url.searchParams.get("page");
  const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;

  if (isNaN(page) || page < 1) {
    return new Response("Invalid page number", { status: 400 });
  }

  const limit = 500;
  const offset = (page - 1) * limit;

  const { analyses, total } = await do_stub.getDumpData(limit, offset);

  const processedAnalyses = analyses.map((analysis) => {
    const baseItem = {
      hostname: analysis.hostname,
      company_domain: analysis.company_domain,
      company_name: analysis.company_name,
      status: analysis.status,
      username: analysis.username,
      profile_image_url: analysis.profile_image_url,
      created_at: analysis.created_at,
      updated_at: analysis.updated_at,
      visits: analysis.visits,
      error: analysis.error,
      category: analysis.category,
      business_description: analysis.business_description,
      industry_sector: analysis.industry_sector,
      keywords: analysis.keywords,
    };

    // If there's a result, parse it and extract run and output data
    if (analysis.result) {
      try {
        const resultData = JSON.parse(analysis.result);

        // Add run data
        if (resultData.run) {
          baseItem.run = resultData.run;
        }

        // Spread output.content onto the item if it exists
        if (
          resultData.output?.content &&
          typeof resultData.output.content === "object"
        ) {
          Object.assign(baseItem, resultData.output.content);
        }

        // Add output.basis if it exists
        if (resultData.output?.basis) {
          baseItem.basis = resultData.output.basis;
        }
      } catch (error) {
        // If JSON parsing fails, just include the raw result
        console.error(
          `Failed to parse result for ${analysis.hostname}:`,
          error
        );
      }
    }

    return baseItem;
  });

  const response = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrevious: page > 1,
    data: processedAnalyses,
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300", // Cache for 5 minutes
    },
  });
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
    // Update table to use hostname instead of slug and add new fields
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
        error TEXT,
        category TEXT,
        business_description TEXT,
        industry_sector TEXT,
        keywords TEXT
      )
    `);

    // Add new columns if they don't exist (for existing databases)
    try {
      this.sql.exec(`ALTER TABLE analyses ADD COLUMN category TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.sql.exec(
        `ALTER TABLE analyses ADD COLUMN business_description TEXT`
      );
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.sql.exec(`ALTER TABLE analyses ADD COLUMN industry_sector TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.sql.exec(`ALTER TABLE analyses ADD COLUMN keywords TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
  }

  async createAnalysis(
    analysis: Omit<AnalysisRow, "visits"> & { visits?: number }
  ): Promise<void> {
    this.sql.exec(
      `
      INSERT OR REPLACE INTO analyses (hostname, company_domain, company_name, status, username, profile_image_url, created_at, updated_at, visits, result, error, category, business_description, industry_sector, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      analysis.error,
      analysis.category,
      analysis.business_description,
      analysis.industry_sector,
      analysis.keywords
    );
  }

  async searchAnalyses(query: string): Promise<AnalysisRow[]> {
    const lowerQuery = query.toLowerCase();

    // Search across multiple fields with partial matching
    const results = this.sql.exec(
      `SELECT * FROM analyses 
       WHERE LOWER(hostname) LIKE ? 
          OR LOWER(company_name) LIKE ?
          OR LOWER(category) LIKE ?
          OR LOWER(industry_sector) LIKE ?
          OR LOWER(keywords) LIKE ?
       ORDER BY 
         CASE 
           WHEN LOWER(hostname) = ? THEN 1
           WHEN LOWER(company_name) = ? THEN 2
           WHEN LOWER(hostname) LIKE ? THEN 3
           WHEN LOWER(company_name) LIKE ? THEN 4
           ELSE 5
         END,
         visits DESC, 
         created_at DESC 
       LIMIT 50`,
      `%${lowerQuery}%`, // hostname LIKE
      `%${lowerQuery}%`, // company_name LIKE
      `%${lowerQuery}%`, // category LIKE
      `%${lowerQuery}%`, // industry_sector LIKE
      `%${lowerQuery}%`, // keywords LIKE
      lowerQuery, // hostname exact match (for ordering)
      lowerQuery, // company_name exact match (for ordering)
      `${lowerQuery}%`, // hostname starts with (for ordering)
      `${lowerQuery}%` // company_name starts with (for ordering)
    );

    return results.toArray() as AnalysisRow[];
  }

  async getDumpData(
    limit: number,
    offset: number
  ): Promise<{ analyses: AnalysisRow[]; total: number }> {
    // Get total count
    const countResults = this.sql.exec(
      "SELECT COUNT(*) as count FROM analyses"
    );
    const total = (countResults.toArray()[0] as any).count;

    // Get paginated data
    const results = this.sql.exec(
      `SELECT hostname, company_domain, company_name, status, username, 
            profile_image_url, created_at, updated_at, visits, error, result,
            category, business_description, industry_sector, keywords
     FROM analyses 
     ORDER BY created_at DESC 
     LIMIT ? OFFSET ?`,
      limit,
      offset
    );

    return {
      analyses: results.toArray() as AnalysisRow[],
      total,
    };
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

  async updateAnalysisResultWithData(
    hostname: string,
    result: string | null,
    error: string | null,
    data: {
      company_name?: string | null;
      category?: string | null;
      business_description?: string | null;
      industry_sector?: string | null;
      keywords?: string | null;
    }
  ): Promise<void> {
    const status = "done"; // Both success and error are considered "done"

    // Build the update query dynamically
    const fields = ["status", "result", "error", "updated_at"];
    const values = [status, result, error, new Date().toISOString()];

    // Add the data fields if they exist
    if (data.company_name !== undefined) {
      fields.push("company_name");
      values.push(data.company_name);
    }
    if (data.category !== undefined) {
      fields.push("category");
      values.push(data.category);
    }
    if (data.business_description !== undefined) {
      fields.push("business_description");
      values.push(data.business_description);
    }
    if (data.industry_sector !== undefined) {
      fields.push("industry_sector");
      values.push(data.industry_sector);
    }
    if (data.keywords !== undefined) {
      fields.push("keywords");
      values.push(data.keywords);
    }

    const setClause = fields.map((field) => `${field} = ?`).join(", ");
    values.push(hostname); // for WHERE clause

    this.sql.exec(
      `UPDATE analyses SET ${setClause} WHERE hostname = ?`,
      ...values
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
