# Amazon Competitive Intelligence MCP Server

MCP server for Amazon product research and competitive intelligence. Works with Claude Desktop, Cursor, and any MCP-compatible AI assistant.

## Tools

| Tool | Description |
|------|-------------|
| `search_products` | Search Amazon products by keyword with BSR, pricing, and brand info |
| `get_product` | Full product details — price, BSR, features, Buy Box seller, Prime status |
| `compare_products` | Side-by-side comparison of multiple ASINs |
| `get_bsr_history` | 30/90/180-day BSR and price trends via Keepa |
| `get_best_sellers` | Top selling products in any Amazon category |
| `estimate_keyword_volume` | Relative search demand for Amazon keywords |

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "amazon-intel": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/amazon-intel-mcp/src/index.ts"],
      "env": {
        "AMAZON_ACCESS_KEY": "your-access-key",
        "AMAZON_SECRET_KEY": "your-secret-key",
        "AMAZON_PARTNER_TAG": "yourstore-20",
        "KEEPA_API_KEY": "optional-keepa-key"
      }
    }
  }
}
```

## Setup

1. Sign up for **Amazon Associates** at https://affiliate-program.amazon.com
2. Request **Product Advertising API** access
3. Generate Access Key / Secret Key pair
4. (Optional) Get a **Keepa API key** at https://keepa.com/#!api for BSR history

## Example Prompts

```
Search for "wireless earbuds" on Amazon
Get full details for ASIN B09V3KXJPB
Compare these 3 products: B09V3KXJPB, B0BHY3Y3YN, B0C5J5K7WF
Show BSR history for B09V3KXJPB over 180 days
What are the best sellers in Electronics?
How much demand is there for "yoga mat" on Amazon?
```

## Data Sources

- **Amazon PA-API 5.0** — Official Product Advertising API (requires Associates account)
- **Keepa API** — Historical BSR, price tracking, best sellers (optional, paid)
- **Amazon Autocomplete** — Keyword demand estimation (free, no key)

## Requirements

- Node.js 18+
- Amazon Associates account + PA-API credentials
- Keepa API key (optional, for historical data)

## Pricing

| Tier | Limit | Price |
|------|-------|-------|
| Free | 10 calls/day | $0 |
| Pro | 5,000 calls/month | $149/month |
| Business | Unlimited | $299/month |

## License

MIT
