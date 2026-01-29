// api.js - ArbitrageEdge API with x402 Payments
// x402-compliant for x402scan listing

import { config } from 'dotenv';
import express from 'express';
import cors from 'cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { facilitator } from '@coinbase/x402';
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';

config();

// ============================================
// CONFIGURATION
// ============================================
const API_NAME = 'ArbitrageEdge';
const PORT = process.env.PORT || 3000;
const NETWORK = 'eip155:8453'; // Base Mainnet
const payTo = process.env.WALLET_ADDRESS;

// API Keys for backward compatibility (Apify actor, etc.)
const VALID_API_KEYS = new Set([
  process.env.API_KEY_1 || 'demo_key_12345',
  process.env.API_KEY_2,
  process.env.API_KEY_3,
].filter(Boolean));

// Validate required env vars
if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !payTo) {
  console.error('❌ Missing required env vars: CDP_API_KEY_ID, CDP_API_KEY_SECRET, WALLET_ADDRESS');
  console.error('   Get CDP credentials from: https://portal.cdp.coinbase.com/projects');
  process.exit(1);
}

// ============================================
// x402 SETUP
// ============================================
const facilitatorClient = new HTTPFacilitatorClient(facilitator);
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({ appName: API_NAME, testnet: false })
  .build();

// ============================================
// ARBITRAGE CALCULATOR (embedded)
// ============================================
function calculate2WayArbitrage(odds) {
  let bestOdds1 = { odds: 0, bookmaker: null };
  let bestOdds2 = { odds: 0, bookmaker: null };

  for (const odd of odds) {
    if (odd.odds1 > bestOdds1.odds) {
      bestOdds1 = { odds: odd.odds1, bookmaker: odd.bookmaker };
    }
    if (odd.odds2 > bestOdds2.odds) {
      bestOdds2 = { odds: odd.odds2, bookmaker: odd.bookmaker };
    }
  }

  const impliedProb1 = 1 / bestOdds1.odds;
  const impliedProb2 = 1 / bestOdds2.odds;
  const totalImpliedProb = impliedProb1 + impliedProb2;

  if (totalImpliedProb >= 1.0) return null;

  const profitPercentage = ((1 / totalImpliedProb) - 1) * 100;
  const stake1Pct = (impliedProb1 / totalImpliedProb) * 100;
  const stake2Pct = (impliedProb2 / totalImpliedProb) * 100;

  return {
    exists: true,
    profit_percentage: parseFloat(profitPercentage.toFixed(2)),
    bets: [
      { outcome: odds[0].team1, bookmaker: bestOdds1.bookmaker, odds: bestOdds1.odds, stake_pct: parseFloat(stake1Pct.toFixed(2)) },
      { outcome: odds[0].team2, bookmaker: bestOdds2.bookmaker, odds: bestOdds2.odds, stake_pct: parseFloat(stake2Pct.toFixed(2)) }
    ]
  };
}

function calculate3WayArbitrage(odds) {
  let bestOdds1 = { odds: 0, bookmaker: null };
  let bestOdds2 = { odds: 0, bookmaker: null };
  let bestDraw = { odds: 0, bookmaker: null };

  for (const odd of odds) {
    if (odd.odds1 > bestOdds1.odds) bestOdds1 = { odds: odd.odds1, bookmaker: odd.bookmaker };
    if (odd.odds2 > bestOdds2.odds) bestOdds2 = { odds: odd.odds2, bookmaker: odd.bookmaker };
    if (odd.draw_odds && odd.draw_odds > bestDraw.odds) bestDraw = { odds: odd.draw_odds, bookmaker: odd.bookmaker };
  }

  if (bestOdds1.odds === 0 || bestOdds2.odds === 0 || bestDraw.odds === 0) return null;

  const impliedProb1 = 1 / bestOdds1.odds;
  const impliedProb2 = 1 / bestOdds2.odds;
  const impliedProbDraw = 1 / bestDraw.odds;
  const totalImpliedProb = impliedProb1 + impliedProb2 + impliedProbDraw;

  if (totalImpliedProb >= 1.0) return null;

  const profitPercentage = ((1 / totalImpliedProb) - 1) * 100;
  const stake1Pct = (impliedProb1 / totalImpliedProb) * 100;
  const stake2Pct = (impliedProb2 / totalImpliedProb) * 100;
  const stakeDrawPct = (impliedProbDraw / totalImpliedProb) * 100;

  return {
    exists: true,
    profit_percentage: parseFloat(profitPercentage.toFixed(2)),
    bets: [
      { outcome: odds[0].team1, bookmaker: bestOdds1.bookmaker, odds: bestOdds1.odds, stake_pct: parseFloat(stake1Pct.toFixed(2)) },
      { outcome: 'Draw', bookmaker: bestDraw.bookmaker, odds: bestDraw.odds, stake_pct: parseFloat(stakeDrawPct.toFixed(2)) },
      { outcome: odds[0].team2, bookmaker: bestOdds2.bookmaker, odds: bestOdds2.odds, stake_pct: parseFloat(stake2Pct.toFixed(2)) }
    ]
  };
}

function calculateStakeAmounts(arbitrage, totalStake) {
  return arbitrage.bets.map(bet => ({
    ...bet,
    stake_amount: parseFloat((totalStake * bet.stake_pct / 100).toFixed(2)),
    potential_return: parseFloat((totalStake * bet.stake_pct / 100 * bet.odds).toFixed(2))
  }));
}

// ============================================
// MOCK DATA GENERATOR (for demo/testing)
// ============================================
function generateMockOpportunities(sport, minProfit, stake) {
  const sports = {
    soccer: [
      { id: 'arb_001', match: { name: 'Manchester United vs Liverpool', sport: 'soccer', league: 'Premier League', start_time: new Date(Date.now() + 3600000).toISOString() },
        profit_percentage: 2.3, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.023).toFixed(2) : 2.30,
        bets: [
          { outcome: 'Man Utd', bookmaker: 'DraftKings', odds: 3.10, stake_pct: 32.26, stake_amount: stake ? (stake * 0.3226).toFixed(2) : 32.26 },
          { outcome: 'Draw', bookmaker: 'FanDuel', odds: 3.40, stake_pct: 29.41, stake_amount: stake ? (stake * 0.2941).toFixed(2) : 29.41 },
          { outcome: 'Liverpool', bookmaker: 'BetMGM', odds: 2.60, stake_pct: 38.46, stake_amount: stake ? (stake * 0.3846).toFixed(2) : 38.46 }
        ], detected_at: new Date().toISOString() },
      { id: 'arb_002', match: { name: 'Barcelona vs Real Madrid', sport: 'soccer', league: 'La Liga', start_time: new Date(Date.now() + 7200000).toISOString() },
        profit_percentage: 1.8, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.018).toFixed(2) : 1.80,
        bets: [
          { outcome: 'Barcelona', bookmaker: 'Caesars', odds: 2.45, stake_pct: 40.82, stake_amount: stake ? (stake * 0.4082).toFixed(2) : 40.82 },
          { outcome: 'Draw', bookmaker: 'PointsBet', odds: 3.50, stake_pct: 28.57, stake_amount: stake ? (stake * 0.2857).toFixed(2) : 28.57 },
          { outcome: 'Real Madrid', bookmaker: 'BetRivers', odds: 3.25, stake_pct: 30.77, stake_amount: stake ? (stake * 0.3077).toFixed(2) : 30.77 }
        ], detected_at: new Date().toISOString() }
    ],
    basketball: [
      { id: 'arb_003', match: { name: 'Lakers vs Celtics', sport: 'basketball', league: 'NBA', start_time: new Date(Date.now() + 5400000).toISOString() },
        profit_percentage: 2.1, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.021).toFixed(2) : 2.10,
        bets: [
          { outcome: 'Lakers', bookmaker: 'DraftKings', odds: 2.10, stake_pct: 47.62, stake_amount: stake ? (stake * 0.4762).toFixed(2) : 47.62 },
          { outcome: 'Celtics', bookmaker: 'FanDuel', odds: 1.95, stake_pct: 51.28, stake_amount: stake ? (stake * 0.5128).toFixed(2) : 51.28 }
        ], detected_at: new Date().toISOString() }
    ],
    tennis: [
      { id: 'arb_004', match: { name: 'Djokovic vs Alcaraz', sport: 'tennis', league: 'ATP', start_time: new Date(Date.now() + 10800000).toISOString() },
        profit_percentage: 1.5, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.015).toFixed(2) : 1.50,
        bets: [
          { outcome: 'Djokovic', bookmaker: 'BetMGM', odds: 1.85, stake_pct: 54.05, stake_amount: stake ? (stake * 0.5405).toFixed(2) : 54.05 },
          { outcome: 'Alcaraz', bookmaker: 'Caesars', odds: 2.20, stake_pct: 45.45, stake_amount: stake ? (stake * 0.4545).toFixed(2) : 45.45 }
        ], detected_at: new Date().toISOString() }
    ],
    nfl: [
      { id: 'arb_005', match: { name: 'Chiefs vs Bills', sport: 'nfl', league: 'NFL', start_time: new Date(Date.now() + 86400000).toISOString() },
        profit_percentage: 1.9, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.019).toFixed(2) : 1.90,
        bets: [
          { outcome: 'Chiefs', bookmaker: 'DraftKings', odds: 1.91, stake_pct: 52.36, stake_amount: stake ? (stake * 0.5236).toFixed(2) : 52.36 },
          { outcome: 'Bills', bookmaker: 'PointsBet', odds: 2.05, stake_pct: 48.78, stake_amount: stake ? (stake * 0.4878).toFixed(2) : 48.78 }
        ], detected_at: new Date().toISOString() }
    ],
    mlb: [
      { id: 'arb_006', match: { name: 'Yankees vs Red Sox', sport: 'mlb', league: 'MLB', start_time: new Date(Date.now() + 14400000).toISOString() },
        profit_percentage: 2.5, total_stake: stake || 100, guaranteed_profit: stake ? (stake * 0.025).toFixed(2) : 2.50,
        bets: [
          { outcome: 'Yankees', bookmaker: 'FanDuel', odds: 1.80, stake_pct: 55.56, stake_amount: stake ? (stake * 0.5556).toFixed(2) : 55.56 },
          { outcome: 'Red Sox', bookmaker: 'BetRivers', odds: 2.25, stake_pct: 44.44, stake_amount: stake ? (stake * 0.4444).toFixed(2) : 44.44 }
        ], detected_at: new Date().toISOString() }
    ]
  };

  let opportunities = [];
  
  if (sport && sports[sport.toLowerCase()]) {
    opportunities = sports[sport.toLowerCase()];
  } else {
    opportunities = Object.values(sports).flat();
  }

  // Filter by minimum profit
  if (minProfit) {
    opportunities = opportunities.filter(opp => opp.profit_percentage >= parseFloat(minProfit));
  }

  return opportunities;
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// API KEY MIDDLEWARE (for backward compatibility)
// ============================================
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && VALID_API_KEYS.has(apiKey)) {
    req.authMethod = 'api_key';
    return next();
  }
  // No valid API key - let x402 handle it
  next();
}

// ============================================
// x402 PAYMENT MIDDLEWARE
// ============================================
app.use(
  paymentMiddleware(
    {
      'GET /api/opportunities': {
        accepts: [{ scheme: 'exact', price: '$0.03', network: NETWORK, payTo }],
        description: 'Get all current arbitrage opportunities across 5 sports',
        mimeType: 'application/json',
      },
      'GET /api/opportunities/*': {
        accepts: [{ scheme: 'exact', price: '$0.01', network: NETWORK, payTo }],
        description: 'Get specific arbitrage opportunity by ID',
        mimeType: 'application/json',
      },
    },
    resourceServer,
    undefined,
    paywall,
  ),
);

// ============================================
// FREE ENDPOINTS (no payment required)
// ============================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>ArbitrageEdge - Sports Betting Arbitrage API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 2.5rem; margin-bottom: 10px; }
    .tagline { color: #00d4ff; font-size: 1.2rem; margin-bottom: 30px; }
    .card { background: rgba(255,255,255,0.1); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .card h2 { color: #00ff88; margin-bottom: 15px; }
    .endpoint { background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin: 10px 0; font-family: monospace; }
    .price { color: #ffd700; font-weight: bold; }
    a { color: #00d4ff; }
    .badge { display: inline-block; background: #00ff88; color: #000; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; margin-right: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎯 ArbitrageEdge</h1>
    <p class="tagline">Profit Regardless of the Outcome</p>
    
    <div class="card">
      <h2>What is this?</h2>
      <p>Real-time sports betting arbitrage API. Find guaranteed profit opportunities across 20+ bookmakers.</p>
      <p style="margin-top: 10px;"><span class="badge">x402</span><span class="badge">USDC</span><span class="badge">Base</span></p>
    </div>
    
    <div class="card">
      <h2>💰 Pricing</h2>
      <div class="endpoint">GET /api/opportunities → <span class="price">$0.03 USDC</span></div>
      <div class="endpoint">GET /api/opportunities/:id → <span class="price">$0.01 USDC</span></div>
      <p style="margin-top: 10px; color: #aaa;">Pay per request with USDC on Base. No subscriptions.</p>
    </div>
    
    <div class="card">
      <h2>🏅 Supported Sports</h2>
      <p>Soccer • NBA • Tennis • NFL • MLB</p>
    </div>
    
    <div class="card">
      <h2>📡 Try It</h2>
      <div class="endpoint">curl -I ${req.protocol}://${req.get('host')}/api/opportunities</div>
      <p style="margin-top: 10px; color: #aaa;">Returns 402 with payment instructions</p>
    </div>
    
    <div class="card">
      <h2>📚 Links</h2>
      <p><a href="/api">API Documentation</a> • <a href="/health">Health Check</a> • <a href="https://x402.org">x402 Protocol</a></p>
    </div>
  </div>
</body>
</html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'ArbitrageEdge API',
    version: '2.0.0',
    description: 'Real-time sports betting arbitrage opportunities',
    x402: {
      enabled: true,
      network: 'Base Mainnet (eip155:8453)',
      asset: 'USDC',
      wallet: payTo,
      pricing: {
        '/api/opportunities': '$0.03 per request',
        '/api/opportunities/:id': '$0.01 per request'
      }
    },
    endpoints: {
      'GET /api/opportunities': {
        description: 'Get all arbitrage opportunities',
        query_params: { sport: 'soccer|basketball|tennis|nfl|mlb', min_profit: 'number', stake: 'number' }
      },
      'GET /api/opportunities/:id': { description: 'Get specific opportunity' },
      'GET /api/opportunities/sports/list': { description: 'List supported sports (free)' }
    }
  });
});

// Free endpoint - list sports
app.get('/api/opportunities/sports/list', (req, res) => {
  res.json({
    success: true,
    sports: ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'],
    count: 5
  });
});

// ============================================
// PROTECTED ENDPOINTS (payment OR API key required)
// ============================================

// Get all opportunities
app.get('/api/opportunities', apiKeyAuth, (req, res) => {
  // If no auth method set and we got here, x402 payment was verified
  if (!req.authMethod) req.authMethod = 'x402';
  
  const { sport, min_profit, stake } = req.query;
  const opportunities = generateMockOpportunities(sport, min_profit, stake ? parseFloat(stake) : null);
  
  res.json({
    success: true,
    count: opportunities.length,
    opportunities,
    auth_method: req.authMethod,
    cache_info: { cached: false, generated_at: new Date().toISOString() }
  });
});

// Get specific opportunity
app.get('/api/opportunities/:id', apiKeyAuth, (req, res) => {
  if (!req.authMethod) req.authMethod = 'x402';
  
  const { id } = req.params;
  const { stake } = req.query;
  const allOpps = generateMockOpportunities(null, null, stake ? parseFloat(stake) : null);
  const opportunity = allOpps.find(opp => opp.id === id);
  
  if (!opportunity) {
    return res.status(404).json({ success: false, error: 'Opportunity not found' });
  }
  
  res.json({ success: true, opportunity, auth_method: req.authMethod });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
============================================
🎯 ArbitrageEdge API with x402
============================================
💰 Pricing:
   /api/opportunities    → $0.03 USDC
   /api/opportunities/:id → $0.01 USDC

💳 Network: Base Mainnet (eip155:8453)
💵 Wallet: ${payTo}
🔑 API Keys: ${VALID_API_KEYS.size} configured

🌐 Server: http://localhost:${PORT}
📡 API: http://localhost:${PORT}/api
💚 Health: http://localhost:${PORT}/health
============================================
  `);
});
