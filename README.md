# **Building a Serverless Competitive Intelligence Platform with MCP \+ Task API**

We built a full-stack competitive intelligence platform by combining data from Reddit and the public web.  View the complete app here: https://competitive-analysis-demo.parallel.ai/

https://github.com/user-attachments/assets/e40770d3-9716-4fde-8116-f356bb6e35d0

## **Overview**

The app we built allows users to:

- Authenticate
- Enter a company domain
- Kickoff a single Parallel `ultra8x` Task configured with Reddit MCP tool calls. The complete Task API call is available [here](https://platform.parallel.ai/play?view=outputs&id=tspec_b9b024bc538649ceb3392a9ce13bc83a).
- Receive a detailed, shareable competitive analysis including Reddit sentiment, market research, investment history, feature parity and more
- Recursively kick off additional analyses on competitors found
- Access results in the UI or via a Competitive Analysis MCP Server with competitive analysis in a token-dense markdown format

Technology stack:

- Parallel [Task API](https://docs.parallel.ai/task-api/task-quickstart) (a single `Ultra8x` call for each market research report)
- Reddit MCP via Task API [Tool Call](https://docs.parallel.ai/features/mcp-tool-call)
- Cloudflare [Workers](https://workers.cloudflare.com/) for compute and [Durable Objects](https://developers.cloudflare.com/durable-objects/) for persistence

Get started in 5 minutes:

- Set up Prerequisites:
  - [Cloudflare account](https://cloudflare.com) (free tier works)
  - [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
  - Parallel API Key (create [here](https://platform.parallel.ai))
- Clone this repository

```shell
git clone https://github.com/your-username/competitive-analysis-demo
   cd competitive-analysis-demo
   npm install
```

- Update wrangler.json configuration

```json
{
  "$schema": "https://unpkg.com/wrangler@latest/config-schema.json",
  "name": "competitor-analysis",
  "main": "worker.ts",
  "compatibility_date": "2025-08-14",
  "assets": { "directory": "./public" },
  "observability": { "logs": { "enabled": true } },
  "durable_objects": {
    "bindings": [
      { "name": "COMPETITOR_ANALYSIS", "class_name": "CompetitorAnalysisDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CompetitorAnalysisDO"] }
  ],
  "routes": [
    {
      "custom_domain": true,
      "pattern": "your-domain.com"
    }
  ]
}
```

Or remove the \`routes\` section entirely to use the default \`\*.workers.dev\` domain.

- Set environment variables

```shell
  # Required: Parallel API key for AI analysis
   wrangler secret put PARALLEL_API_KEY
   # Required: Webhook secret to receive task results
   wrangler secret put PARALLEL_WEBHOOK_SECRET
   # Required: Reddit MCP URL for enhanced insights
   wrangler secret put MCP_URL
```

- Deploy:

```shell
  wrangler deploy
```

Note: The Task API Spec is defined in \`public/task.schema.json\` \- modify this to change what data gets analyzed based on your use case.

![][image1]

## **Why This Architecture**

**Single Task API Call vs Web Research Pipeline**  
Using the Task API provides the benefits of simplicity, quality and cost-effectiveness vs a typical web research pipeline. The Task API has been [benchmarked](https://parallel.ai/blog/deep-research-benchmarks) against other providers to provide the best-in-class quality at each price point. It also handles the end-to-end web research pipeline, removing the need to build a pipeline that includes reasoning, search, retrieval, ranking, compression and MCP tool call configuration.

The `Ultra8x` processor was chosen out of each of the Task API [processor](https://docs.parallel.ai/task-api/core-concepts/choose-a-processor) options because the user experience is designed for asynchronous execution, allowing for slower-running, more in-depth research. The `Ultra8x` processor can also handle 25 output fields, allowing for several questions to be answered about each company – covering Reddit sentiment, investment history, feature parity, competitor mapping and more in a single API call. This removes the need for piecing together several outputs into a final format.

**Reddit MCP as a Competitive Research Tool**  
Reddit has long been considered a valuable resource for individuals to receive unfiltered reviews and advice on various products and companies. The Reddit sentiment surrounding a company is often a strong indicator of the sentiment in their broader user base. It is also an indicator of market presence and mindshare. This makes Reddit a great tool for competitive analysis. Combining comprehensive Reddit analysis with deep web research is unique and valuable for competitive insights.

**Publicly Available Results**

The system acts as both MCP client and server; external AI systems can consume our competitive analysis while we consume specialized analysis services. This can be very powerful as an agentic research tool; all the research done by Parallel across companies can be included as context for any further analysis.

In this application, we also implement a pipeline that combines company and competitor analyses into a single token-dense markdown context of approximately 15K tokens. This is a careful context engineering design that helps LLMs effectively interpret context from each analysis; each report is also available as a machine-friendly .md file using this approach.

**Serverless Edge Deployment**

Cloudflare Workers eliminate cold starts and provide global distribution. Analysis results cache at edge locations worldwide, making subsequent requests for the same company's intelligence load instantly regardless of geographic location.

**Webhooks for Asynchronous Processing**

Complex analysis tasks run asynchronously with webhook callbacks, preventing timeout issues while allowing users to track progress. The webhook pattern scales better than long-polling or WebSocket approaches for sporadic, compute-intensive tasks. `Ultra8x` Tasks are long-running, so the application prompts users to return after 30 minutes, with the webhook implementation ensuring that completion is efficiently listened for, even if the user closes the page.

**Plain HTML and JS as a Frontend Language**

This choice helps us reduce complexity by removing the framework to HTML+JS+CSS build-step. It incentivizes the developer to reduce the amount of complex interactions because they’re harder to make in plain HTML and JS. It also simplifies server-side rendering, resulting in highly accessible and performant dynamically generated HTML pages from our data.

This increases accessibility for both humans and machines (such as browser-agents) as complex interactions may be harder to read programmatically which could hide crucial information to AI.

<img width="1340" height="1168" alt="image" src="https://github.com/user-attachments/assets/15576826-c0a3-4608-a004-bf702136a32e" />


## **Implementation**

### **Dependencies and Environment Setup**

Dependencies remain minimal by leveraging platform capabilities:

- **Queryable-object** allows an admin-ui for the Durable Object database
- **SimplerAuth** provides one line OAuth integration with X without secret management
- **with-mcp** handles the MCP protocol without custom implementation
- **Parallel AI SDK** abstracts task orchestration and webhook management

```ts
import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { withMcp } from "with-mcp";
import { UserContext, withSimplerAuth } from "simplerauth-client";
import { Parallel } from "parallel-web";
```

Environment configuration focuses on service endpoints and authentication tokens rather than complex service credentials:

```ts
interface Env {
  MCP_URL: string; // Reddit MCP server endpoint
  PARALLEL_API_KEY: string; // Parallel AI service authentication
  PARALLEL_WEBHOOK_SECRET: string; // Webhook signature verification
  COMPETITOR_ANALYSIS_DO: DurableObjectNamespace;
}
```

### **Defining the Data Schema with Queryable**

The analysis data structure captures both immediate analysis results and metadata for search and discovery:

```ts
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
  result: string | null; // JSON string of structured analysis
  error: string | null;
  // Enhanced search fields extracted from analysis
  category: string | null;
  business_description: string | null;
  industry_sector: string | null;
  keywords: string | null;
}

@Queryable()
export class CompetitorAnalysisDO extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
  }

  async createAnalysis(analysis: AnalysisRow): Promise<void> {
    // Check for existing recent analysis
    const results = this.sql.exec(
      "SELECT * FROM analyses WHERE hostname = ? ORDER BY updated_at DESC LIMIT 1",
      analysis.hostname
    );
    const existing = results.toArray()[0] as AnalysisRow | undefined;

    if (existing?.status === "done") {
      // Add your daysBetween logic here if needed
      const daysDiff = daysBetween(new Date(existing.updated_at), new Date());
      if (daysDiff < 14) {
        throw new Error("Recent analysis exists");
      }
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO analyses (hostname, company_domain, company_name, status, username, profile_image_url, created_at, updated_at, visits, result, error, category, business_description, industry_sector, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const results = this.sql.exec(
      `SELECT * FROM analyses 
       WHERE LOWER(company_name) LIKE ?
          OR LOWER(business_description) LIKE ?
          OR LOWER(keywords) LIKE ?
       ORDER BY visits DESC, created_at DESC 
       LIMIT 20`,
      `%${lowerQuery}%`,
      `%${lowerQuery}%`,
      `%${lowerQuery}%`
    );
    return results.toArray() as AnalysisRow[];
  }
}
```

The 14-day refresh policy balances data freshness with processing costs. The search functionality indexes specific fields that contain the most relevant information for discovery queries.

### **Designing the Structured Enrichment Task via Ultra8x**

An effective competitive analysis requires a carefully written Task Spec which aims to capture all the information required. In the Task Spec, we follow the general Task Spec guidelines:

- Declarative description fields
- Majority flat output schema
- Approximately 25 output fields in total
- We construct the output fields so that they are mutually exclusive – each finding a key piece of information that we can display in the final report

Importantly, we also include a `company_fits_criteria` output field which serves as a secondary verification on the company domain, ensuring that the company is legitimate and can have a comprehensive competitive analysis done on it.

The complete Task can be found [here](https://competitive-analysis-demo.parallel.ai/task.schema.json). Next, the Reddit MCP server is added to the Task Spec itself as a tool, using the Tool Calling feature in the Parallel Task API:

```ts
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
```

### **Handling Webhook Results and Competitor Discovery**

Webhook processing updates analysis results and triggers recursive competitor analysis. First, Webhook signature verification:

```ts
const webhookId = request.headers.get("webhook-id");
const webhookTimestamp = request.headers.get("webhook-timestamp");
const webhookSignature = request.headers.get("webhook-signature");

const isSignatureValid = await verifyWebhookSignature(
  env.PARALLEL_WEBHOOK_SECRET,
  webhookId,
  webhookTimestamp,
  body,
  webhookSignature
);
```

Competitor discovery logic:

```ts
if (result.run.metadata?.isDeep) {
  const competitors = result.output.content?.competitors as any[] | undefined;
  const hostnames = competitors
    ?.map((comp: { hostname: string }) => comp.hostname)
    .filter(Boolean);

  if (hostnames?.length) {
    await Promise.all(
      hostnames.map(async (hostname) => {
        const existingAnalysis = await do_stub.getAnalysis(hostname);

        if (
          existingAnalysis &&
          !existingAnalysis.error &&
          !isAnalysisOld(existingAnalysis.updated_at)
        ) {
          return; // Skip if recent analysis exists
        }

        await performAnalysis(env, do_stub, {
          isDeep: false, // Prevent infinite recursion
          hostname,
          url,
          username,
          profile_image_url,
        });
      })
    );
  }
}
```

Data extraction and storage:

```ts
const updateData = {
  company_name: analysisData.company_name || null,
  category: analysisData.category || null,
  business_description: analysisData.business_description || null,
  industry_sector: analysisData.industry_sector || null,
  keywords: analysisData.keywords || null,
};

await do_stub.updateAnalysisResultWithData(
  hostname,
  JSON.stringify(result),
  null,
  updateData
);
```

### **Deploying MCP Server Capabilities**

The worker exposes analysis tools through MCP protocol integration:

```ts
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

        const do_id = env.COMPETITOR_ANALYSIS.idFromName("v5");
        const do_stub = env.COMPETITOR_ANALYSIS.get(do_id);

        // Route handling logic here...
        switch (pathname) {
          case "/":
            return handleHome(do_stub);
          case "/new":
            return handleNew(request, do_stub, ctx, env);
          // ... other routes
        }
      },
      { isLoginRequired: false }
    );

    return withMcp(handler, openapi, {
      serverInfo: {
        name: "Competitive Analysis MCP",
        version: "1.0.0",
      },
      toolOperationIds: ["getAnalysisMarkdown"],
    })(request, env, ctx);
  },
};

// MCP tool implementation (for /md/ endpoint)
const getAnalysisMarkdown = async (
  hostname: string,
  env: Env
): Promise<string> => {
  const do_id = env.COMPETITOR_ANALYSIS.idFromName("v5");
  const do_stub = env.COMPETITOR_ANALYSIS.get(do_id);

  const analysis = await do_stub.getAnalysis(hostname);
  if (!analysis?.result) {
    throw new Error(`No analysis available for ${hostname}`);
  }

  const result = JSON.parse(analysis.result);
  const primaryData = result.output?.content || {};

  // Get competitor analyses
  const competitors = primaryData.competitors || [];
  const competitorHostnames = competitors
    .map((comp: { hostname: string }) => comp.hostname)
    .filter(Boolean);

  const competitorAnalyses = await Promise.all(
    competitorHostnames.map(async (compHostname: string) => {
      const compAnalysis = await do_stub.getAnalysis(compHostname);
      if (compAnalysis?.status === "done" && compAnalysis.result) {
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

  return buildComprehensiveCompetitiveReport(
    { hostname, company_name: analysis.company_name, data: primaryData },
    validCompetitorAnalyses
  );
};
```

The MCP integration happens at the worker level, wrapping the entire application. This allows external AI systems to discover and call available tools while preserving normal HTTP functionality for web users.

### **Authentication Strategy Implementation**

Authentication applies selectively based on endpoint and functionality:

```ts
// Analysis creation requires authentication
if (path === "/new") {
  if (!ctx.authenticated) {
    return renderLoginPage(url.searchParams.get("company"));
  }

  // Rate limiting for users
  const do_id = env.COMPETITOR_ANALYSIS.idFromName("v5");
  const do_stub = env.COMPETITOR_ANALYSIS.get(do_id);

  const userAnalyses = await do_stub.getUserAnalysisCount(
    ctx.user?.username || ""
  );

  if (userAnalyses >= ANALYSES_LIMIT) {
    return new Response(renderRateLimitPage(), {
      headers: { "content-type": "text/html" },
    });
  }

  return handleNewAnalysis(request, env, ctx);
}
```

MCP endpoints (`/md/`) remain public to enable AI agent access without complex authentication flows. This design choice prioritizes AI system interoperability over access control.

## **Resources**

- [Setup](SETUP.md)
- [Deployed App](https://competitive-analysis-demo.parallel.ai/)
- Parallel MCP [Tool Calling Documentation](https://docs.parallel.ai/features/mcp-tool-call)

[image1]: data:image/png;base64,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
