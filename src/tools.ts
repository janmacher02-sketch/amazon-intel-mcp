import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Amazon Product Advertising API v5 (PA-API 5.0)
// Requires: Access Key, Secret Key, Partner Tag (Associates account)

function getCredentials() {
  const accessKey = process.env.AMAZON_ACCESS_KEY;
  const secretKey = process.env.AMAZON_SECRET_KEY;
  const partnerTag = process.env.AMAZON_PARTNER_TAG;
  if (!accessKey || !secretKey || !partnerTag) {
    throw new Error("Missing AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, or AMAZON_PARTNER_TAG environment variables.");
  }
  return { accessKey, secretKey, partnerTag };
}

// AWS Signature V4 for PA-API
async function sign(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return new Uint8Array(sig);
}

async function sha256(data: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function paApiFetch(operation: string, payload: Record<string, any>, marketplace = "www.amazon.com"): Promise<any> {
  const { accessKey, secretKey, partnerTag } = getCredentials();

  const host = "webservices.amazon.com";
  const region = "us-east-1";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}/paapi5/${operation.toLowerCase()}`;

  const body = JSON.stringify({
    ...payload,
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: marketplace,
  });

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";

  const payloadHash = await sha256(body);
  const canonicalRequest = `POST\n/paapi5/${operation.toLowerCase()}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const enc = new TextEncoder();
  let sigKey = await sign(enc.encode(`AWS4${secretKey}`), dateStamp);
  sigKey = await sign(sigKey, region);
  sigKey = await sign(sigKey, service);
  sigKey = await sign(sigKey, "aws4_request");

  const cryptoKey = await crypto.subtle.importKey("raw", sigKey.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(stringToSign))))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "amz-1.0",
      "Host": host,
      "X-Amz-Date": amzDate,
      "X-Amz-Target": `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`,
      "Authorization": authorizationHeader,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`PA-API error ${res.status}: ${errBody}`);
  }
  return res.json();
}

// Keepa API (for historical BSR tracking — optional)
async function keepaFetch(path: string): Promise<any> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY required for historical data.");
  const res = await fetch(`https://api.keepa.com${path}&key=${key}`);
  if (!res.ok) throw new Error(`Keepa error ${res.status}`);
  return res.json();
}

// ─── Register all tools ───────────────────────────────────────────────────────

export function registerTools(server: McpServer) {

  // ── Search Products ─────────────────────────────────────────────────────────

  server.tool(
    "search_products",
    "Search Amazon products by keyword. Returns title, price, BSR, rating, review count, and ASIN for each result.",
    {
      keywords: z.string().describe("Search keywords, e.g. 'wireless earbuds', 'yoga mat'"),
      category: z.string().optional().describe("Amazon search index (category), e.g. 'Electronics', 'Sports'. Default: 'All'"),
      sort_by: z.enum(["Relevance", "Price:LowToHigh", "Price:HighToLow", "AvgCustomerReviews", "NewestArrivals"]).default("Relevance").describe("Sort order"),
      min_price: z.number().optional().describe("Minimum price in cents (e.g. 1000 = $10.00)"),
      max_price: z.number().optional().describe("Maximum price in cents (e.g. 5000 = $50.00)"),
    },
    async ({ keywords, category, sort_by, min_price, max_price }) => {
      const payload: any = {
        Keywords: keywords,
        SearchIndex: category ?? "All",
        SortBy: sort_by,
        Resources: [
          "ItemInfo.Title",
          "ItemInfo.ByLineInfo",
          "Offers.Listings.Price",
          "BrowseNodeInfo.BrowseNodes.SalesRank",
          "ItemInfo.Classifications",
        ],
        ItemCount: 10,
      };

      if (min_price !== undefined || max_price !== undefined) {
        payload.MinPrice = min_price;
        payload.MaxPrice = max_price;
      }

      const data = await paApiFetch("SearchItems", payload);

      if (!data.SearchResult?.Items?.length) {
        return { content: [{ type: "text", text: `No products found for "${keywords}".` }] };
      }

      let text = `**Amazon Search: "${keywords}"** (${data.SearchResult.TotalResultCount} total)\n\n`;

      for (const item of data.SearchResult.Items) {
        const title = item.ItemInfo?.Title?.DisplayValue ?? "(no title)";
        const price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount ?? "—";
        const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ?? "—";
        const bsr = item.BrowseNodeInfo?.BrowseNodes?.[0]?.SalesRank ?? "—";
        const category = item.ItemInfo?.Classifications?.Binding?.DisplayValue ?? "—";

        text += `---\n`;
        text += `**${title}**\n`;
        text += `ASIN: ${item.ASIN} | Price: ${price} | Brand: ${brand}\n`;
        text += `BSR: #${bsr} in ${category}\n`;
        text += `URL: ${item.DetailPageURL}\n\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // ── Get Product Details ─────────────────────────────────────────────────────

  server.tool(
    "get_product",
    "Get detailed information about an Amazon product by ASIN. Includes price, BSR, ratings, features, and Buy Box status.",
    {
      asin: z.string().describe("Amazon ASIN (e.g. 'B09V3KXJPB')"),
    },
    async ({ asin }) => {
      const data = await paApiFetch("GetItems", {
        ItemIds: [asin],
        Resources: [
          "ItemInfo.Title",
          "ItemInfo.ByLineInfo",
          "ItemInfo.Features",
          "ItemInfo.ProductInfo",
          "ItemInfo.TechnicalInfo",
          "ItemInfo.Classifications",
          "Offers.Listings.Price",
          "Offers.Listings.DeliveryInfo.IsFreeShippingEligible",
          "Offers.Listings.DeliveryInfo.IsPrimeEligible",
          "Offers.Listings.MerchantInfo",
          "Offers.Listings.Condition",
          "Offers.Summaries",
          "BrowseNodeInfo.BrowseNodes.SalesRank",
          "Images.Primary.Large",
          "ParentASIN",
        ],
      });

      const item = data.ItemsResult?.Items?.[0];
      if (!item) {
        return { content: [{ type: "text", text: `Product ${asin} not found.` }] };
      }

      const info = item.ItemInfo;
      const offer = item.Offers?.Listings?.[0];
      const bsr = item.BrowseNodeInfo?.BrowseNodes?.[0]?.SalesRank;

      let text = `**${info?.Title?.DisplayValue ?? asin}**\n\n`;
      text += `| Property | Value |\n|----------|-------|\n`;
      text += `| ASIN | ${item.ASIN} |\n`;
      text += `| Brand | ${info?.ByLineInfo?.Brand?.DisplayValue ?? "—"} |\n`;
      text += `| Price | ${offer?.Price?.DisplayAmount ?? "—"} |\n`;
      text += `| BSR | ${bsr ? `#${bsr}` : "—"} |\n`;
      text += `| Category | ${info?.Classifications?.Binding?.DisplayValue ?? "—"} |\n`;
      text += `| Prime | ${offer?.DeliveryInfo?.IsPrimeEligible ? "✅ Yes" : "❌ No"} |\n`;
      text += `| Free Shipping | ${offer?.DeliveryInfo?.IsFreeShippingEligible ? "✅ Yes" : "❌ No"} |\n`;
      text += `| Buy Box Seller | ${offer?.MerchantInfo?.Name ?? "—"} |\n`;
      text += `| Condition | ${offer?.Condition?.Value ?? "—"} |\n`;
      text += `| Parent ASIN | ${item.ParentASIN ?? "—"} |\n`;

      if (info?.Features?.DisplayValues?.length) {
        text += `\n**Key Features:**\n`;
        for (const f of info.Features.DisplayValues.slice(0, 5)) {
          text += `• ${f}\n`;
        }
      }

      const summary = item.Offers?.Summaries?.[0];
      if (summary) {
        text += `\n**Offer Summary:** Lowest new: ${summary.LowestPrice?.DisplayAmount ?? "—"} | ${summary.OfferCount ?? "?"} offers\n`;
      }

      text += `\nURL: ${item.DetailPageURL}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Compare Products ────────────────────────────────────────────────────────

  server.tool(
    "compare_products",
    "Compare multiple Amazon products side-by-side by ASINs. Returns price, BSR, ratings, and Buy Box seller for each.",
    {
      asins: z.array(z.string()).min(2).max(10).describe("Array of ASINs to compare (2-10)"),
    },
    async ({ asins }) => {
      const data = await paApiFetch("GetItems", {
        ItemIds: asins,
        Resources: [
          "ItemInfo.Title",
          "ItemInfo.ByLineInfo",
          "Offers.Listings.Price",
          "Offers.Listings.MerchantInfo",
          "Offers.Listings.DeliveryInfo.IsPrimeEligible",
          "BrowseNodeInfo.BrowseNodes.SalesRank",
        ],
      });

      const items = data.ItemsResult?.Items ?? [];
      if (!items.length) {
        return { content: [{ type: "text", text: "No products found for the given ASINs." }] };
      }

      let text = `**Product Comparison (${items.length} products):**\n\n`;
      text += `| ASIN | Title | Price | BSR | Prime | Buy Box Seller |\n`;
      text += `|------|-------|-------|-----|-------|----------------|\n`;

      for (const item of items) {
        const title = (item.ItemInfo?.Title?.DisplayValue ?? "—").slice(0, 50);
        const price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount ?? "—";
        const bsr = item.BrowseNodeInfo?.BrowseNodes?.[0]?.SalesRank ?? "—";
        const prime = item.Offers?.Listings?.[0]?.DeliveryInfo?.IsPrimeEligible ? "✅" : "❌";
        const seller = item.Offers?.Listings?.[0]?.MerchantInfo?.Name ?? "—";
        text += `| ${item.ASIN} | ${title} | ${price} | #${bsr} | ${prime} | ${seller} |\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // ── BSR History (via Keepa) ─────────────────────────────────────────────────

  server.tool(
    "get_bsr_history",
    "Get Best Seller Rank history for an Amazon product (requires Keepa API key). Shows 30/90/180-day BSR trends and price changes.",
    {
      asin: z.string().describe("Amazon ASIN"),
      domain: z.number().default(1).describe("Amazon domain ID: 1=.com, 3=.co.uk, 4=.de, 8=.fr, 9=.co.jp"),
    },
    async ({ asin, domain }) => {
      const data = await keepaFetch(`/product?asin=${asin}&domain=${domain}&stats=180`);

      const product = data.products?.[0];
      if (!product) {
        return { content: [{ type: "text", text: `No Keepa data found for ASIN ${asin}.` }] };
      }

      const stats = product.stats;
      let text = `**BSR History: ${product.title ?? asin}**\n`;
      text += `ASIN: ${asin}\n\n`;

      text += `| Metric | Current | 30d Avg | 90d Avg | 180d Avg |\n`;
      text += `|--------|---------|---------|---------|----------|\n`;

      if (stats?.current) {
        text += `| BSR | ${stats.current[3] ?? "—"} | ${stats.avg30?.[3] ?? "—"} | ${stats.avg90?.[3] ?? "—"} | ${stats.avg180?.[3] ?? "—"} |\n`;
        text += `| Price (cents) | ${stats.current[0] ?? "—"} | ${stats.avg30?.[0] ?? "—"} | ${stats.avg90?.[0] ?? "—"} | ${stats.avg180?.[0] ?? "—"} |\n`;
        text += `| New offers | ${stats.current[11] ?? "—"} | ${stats.avg30?.[11] ?? "—"} | ${stats.avg90?.[11] ?? "—"} | ${stats.avg180?.[11] ?? "—"} |\n`;
      }

      if (product.salesRankReference !== undefined) {
        text += `\n**Estimated sales/day:** ~${product.monthlySold ?? "unknown"}\n`;
      }

      text += `\nKeepa URL: https://keepa.com/#!product/1-${asin}`;

      return { content: [{ type: "text", text }] };
    }
  );

  // ── Browse Best Sellers ─────────────────────────────────────────────────────

  server.tool(
    "get_best_sellers",
    "Get Amazon best sellers for a category via Keepa. Returns top products with BSR, price, and estimated sales.",
    {
      category: z.number().describe("Amazon browse node ID (category ID). Use 'search_products' to discover category IDs."),
      domain: z.number().default(1).describe("Amazon domain ID: 1=.com, 3=.co.uk, 4=.de"),
    },
    async ({ category, domain }) => {
      const data = await keepaFetch(`/bestsellers?domain=${domain}&category=${category}`);

      if (!data.bestSellersList?.asinList?.length) {
        return { content: [{ type: "text", text: `No best sellers found for category ${category}.` }] };
      }

      const asins = data.bestSellersList.asinList.slice(0, 20);
      let text = `**Best Sellers — Category ${category} (Top ${asins.length}):**\n\n`;
      text += `| Rank | ASIN | URL |\n`;
      text += `|------|------|-----|\n`;

      asins.forEach((asin: string, i: number) => {
        text += `| #${i + 1} | ${asin} | https://amazon.com/dp/${asin} |\n`;
      });

      text += `\n💡 Use \`get_product\` or \`compare_products\` with these ASINs for detailed analysis.`;

      return { content: [{ type: "text", text }] };
    }
  );

  // ── Keyword Search Volume Estimate ──────────────────────────────────────────

  server.tool(
    "estimate_keyword_volume",
    "Estimate relative search volume for Amazon keywords using autocomplete suggestions. Higher suggestion count = higher demand.",
    {
      keyword: z.string().describe("Base keyword to analyze, e.g. 'yoga mat'"),
    },
    async ({ keyword }) => {
      const prefixes = "abcdefghijklmnopqrstuvwxyz".split("");
      const suggestions: string[] = [];

      // Use Amazon autocomplete for search volume estimation
      for (const prefix of prefixes.slice(0, 10)) {
        try {
          const res = await fetch(
            `https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=aps&prefix=${encodeURIComponent(keyword + " " + prefix)}`
          );
          if (res.ok) {
            const data = await res.json() as any;
            if (data.suggestions) {
              for (const s of data.suggestions) {
                if (s.value && !suggestions.includes(s.value)) {
                  suggestions.push(s.value);
                }
              }
            }
          }
        } catch { /* autocomplete can be flaky */ }
      }

      let text = `**Amazon Keyword Analysis: "${keyword}"**\n\n`;
      text += `Total related suggestions found: **${suggestions.length}**\n`;
      text += `Demand signal: **${suggestions.length > 50 ? "🔥 Very High" : suggestions.length > 30 ? "🟢 High" : suggestions.length > 15 ? "🟡 Medium" : "🔴 Low"}**\n\n`;

      if (suggestions.length > 0) {
        text += `**Top Related Searches:**\n`;
        for (const s of suggestions.slice(0, 25)) {
          text += `• ${s}\n`;
        }
        if (suggestions.length > 25) {
          text += `\n... and ${suggestions.length - 25} more\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
