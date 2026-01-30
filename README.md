# 🎯 ArbitrageEdge API (x402 Compliant)

Real-time sports betting arbitrage API with x402 crypto payments.

[![x402](https://img.shields.io/badge/x402-enabled-00ff88?style=for-the-badge)](https://x402.org)
[![Base](https://img.shields.io/badge/Base-Mainnet-0052FF?style=for-the-badge)](https://base.org)
[![USDC](https://img.shields.io/badge/USDC-Payments-2775CA?style=for-the-badge)](https://www.circle.com/en/usdc)

## 💰 Pricing

| Endpoint | Price |
|----------|-------|
| `GET /api/opportunities` | $0.03 USDC |
| `GET /api/opportunities/:id` | $0.01 USDC |

## 🏅 Supported Sports

- ⚽ Soccer (3-way betting)
- 🏀 Basketball/NBA (2-way)
- 🎾 Tennis (2-way)
- 🏈 NFL (2-way)
- ⚾ MLB (2-way)

## 📁 Project Structure

```
arbitrageedge-x402/
├── package.json      # Dependencies (x402 SDK v2.1.0)
├── bootstrap.js      # Crypto polyfill (REQUIRED)
├── api.js            # Main API (~300 lines)
├── .env.example      # Environment template
└── README.md
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:
- `CDP_API_KEY_ID` - From [CDP Portal](https://portal.cdp.coinbase.com)
- `CDP_API_KEY_SECRET` - From CDP Portal
- `WALLET_ADDRESS` - Your Base mainnet address for receiving USDC

### 3. Run Locally

```bash
npm start
```

### 4. Test x402 Response

```bash
# Should return 402 Payment Required
curl -I http://localhost:3000/api/opportunities
```

## 🔐 Authentication

This API supports **two** authentication methods:

### 1. x402 Payments (for AI agents)
```bash
# First request returns 402 with payment instructions
curl -I https://your-api.railway.app/api/opportunities

# Agent pays USDC, retries with X-Payment header
```

### 2. API Keys (for Apify actor, human developers)
```bash
curl -H "X-API-Key: demo_key_12345" \
  https://your-api.railway.app/api/opportunities
```

## 📡 API Endpoints

### Free Endpoints
- `GET /` - Landing page
- `GET /health` - Health check
- `GET /api` - API documentation
- `GET /api/opportunities/sports/list` - List sports

### Protected Endpoints (payment or API key required)
- `GET /api/opportunities` - All arbitrage opportunities
- `GET /api/opportunities/:id` - Specific opportunity

### Query Parameters
| Param | Type | Description |
|-------|------|-------------|
| `sport` | string | Filter: soccer, basketball, tennis, nfl, mlb |
| `min_profit` | number | Minimum profit % (e.g., 2.0) |
| `stake` | number | Calculate amounts for this stake (e.g., 100) |

## 📊 Response Example

```json
{
  "success": true,
  "count": 6,
  "opportunities": [
    {
      "id": "arb_001",
      "match": {
        "name": "Manchester United vs Liverpool",
        "sport": "soccer",
        "league": "Premier League"
      },
      "profit_percentage": 2.3,
      "total_stake": 100,
      "guaranteed_profit": 2.30,
      "bets": [
        { "outcome": "Man Utd", "bookmaker": "DraftKings", "odds": 3.10, "stake_amount": 32.26 },
        { "outcome": "Draw", "bookmaker": "FanDuel", "odds": 3.40, "stake_amount": 29.41 },
        { "outcome": "Liverpool", "bookmaker": "BetMGM", "odds": 2.60, "stake_amount": 38.46 }
      ]
    }
  ]
}
```

## ✅ x402scan Compliance Checklist

- [x] x402 SDK v2.1.0
- [x] Crypto polyfill via bootstrap.js
- [x] Correct imports (`@x402/core/server`)
- [x] Facilitator setup (direct, not createFacilitatorConfig)
- [x] Route patterns with wildcards
- [x] Paywall as 4th middleware param
- [x] Proper 402 responses
- [x] Base Mainnet (eip155:8453)
- [x] USDC payments

## 🔗 Links

- [x402 Protocol](https://x402.org)
- [x402scan](https://x402scan.com)
- [CDP Portal](https://portal.cdp.coinbase.com)
- [Base Network](https://base.org)
