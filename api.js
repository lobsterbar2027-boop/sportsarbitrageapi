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
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

config();

// ============================================
// CONFIGURATION
// ============================================
const API_NAME = 'ArbitrageEdge';
const PORT = process.env.PORT || 3000;
const NETWORK = 'eip155:8453'; // Base Mainnet
const payTo = process.env.WALLET_ADDRESS;

// The Odds API Configuration
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// Sports configuration for The Odds API
// See https://the-odds-api.com/sports-odds-data/sports-apis.html for all sport keys
const SPORTS_CONFIG = {
  soccer: { api_key: 'soccer_epl', has_draw: true, display_name: 'Soccer - Premier League' },
  basketball: { api_key: 'basketball_nba', has_draw: false, display_name: 'NBA Basketball' },
  tennis: { api_key: 'tennis_atp_aus_open', has_draw: false, display_name: 'Tennis - ATP', 
            fallback_keys: ['tennis_wta_aus_open', 'tennis_atp_us_open', 'tennis_wta_us_open'] },
  nfl: { api_key: 'americanfootball_nfl', has_draw: false, display_name: 'NFL' },
  mlb: { api_key: 'baseball_mlb', has_draw: false, display_name: 'MLB Baseball' },
};

// In-memory cache
const cache = {
  data: {},        // { sport: { opportunities: [], timestamp: Date } }
  duration: 30 * 60 * 1000,  // 30 minutes
};

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
// x402scan BAZAAR SCHEMA (enables dropdown)
// ============================================
const BASE_URL = process.env.BASE_URL || 'https://sportsarbitrageapi-production.up.railway.app';

const SUPPORTED_SPORTS = ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'];

const SPORT_NAMES = {
  soccer: 'Soccer (Premier League, La Liga, etc.)',
  basketball: 'Basketball (NBA)',
  tennis: 'Tennis (ATP)',
  nfl: 'NFL (American Football)',
  mlb: 'MLB (Baseball)',
};

// Bazaar schema - this creates the dropdown in x402scan!
const bazaarSchema = {
  input: { sport: 'soccer' },
  output: {
    success: true,
    sport: 'basketball',
    summary: '🏀 Found 1 arbitrage opportunity in Basketball with avg 2.1% guaranteed profit',
    count: 1,
    avg_profit: '2.1%',
    opportunities: [
      {
        match: 'Lakers vs Celtics',
        league: 'NBA',
        profit: '2.1% guaranteed',
        guaranteed_profit: '$2.10',
        total_stake: '$100',
        instructions: 'Lakers: $47.62 @ 2.10 on DraftKings | Celtics: $52.38 @ 1.95 on FanDuel'
      }
    ]
  },
  schema: {
    type: 'object',
    properties: {
      sport: {
        type: 'string',
        enum: SUPPORTED_SPORTS,
        description: 'Sport to find arbitrage opportunities for',
      },
    },
    required: ['sport'],
  },
};

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
// THE ODDS API - REAL DATA SCRAPING
// ============================================

/**
 * Check if cached data is still valid
 */
function isCacheValid(sport) {
  const cached = cache.data[sport];
  if (!cached) return false;
  return (Date.now() - cached.timestamp) < cache.duration;
}

/**
 * Scrape real odds from The Odds API
 */
async function scrapeOddsForSport(sport) {
  const sportConfig = SPORTS_CONFIG[sport];
  if (!sportConfig) {
    console.log(`❌ Unknown sport: ${sport}`);
    return { matches: [], error: `Unknown sport: ${sport}` };
  }
  
  console.log(`🔍 Scraping ${sportConfig.display_name} from The Odds API...`);
  
  if (!ODDS_API_KEY) {
    console.log('❌ ODDS_API_KEY not set in Railway environment variables');
    return { matches: [], error: 'ODDS_API_KEY not configured. Add it in Railway Variables.' };
  }
  
  // Try main API key and fallbacks
  const keysToTry = [sportConfig.api_key, ...(sportConfig.fallback_keys || [])];
  
  for (const apiKey of keysToTry) {
    try {
      console.log(`   Trying API key: ${apiKey}`);
      const url = `${ODDS_API_BASE}/sports/${apiKey}/odds`;
      
      const response = await fetch(url + '?' + new URLSearchParams({
        apiKey: ODDS_API_KEY,
        regions: 'us,uk,eu',
        markets: 'h2h',
        oddsFormat: 'decimal'
      }));
      
      if (!response.ok) {
        console.log(`   ⚠️ ${apiKey}: ${response.status} - ${response.statusText}`);
        continue;
      }
      
      const games = await response.json();
      
      if (!games || games.length === 0) {
        console.log(`   ⚠️ ${apiKey}: No games found`);
        continue;
      }
      
      console.log(`   ✅ ${apiKey}: Found ${games.length} games`);
      
      // Convert to our odds format
      const allMatches = [];
      
      for (const game of games) {
        const matchOdds = [];
        
        for (const bookmaker of game.bookmakers) {
          const market = bookmaker.markets.find(m => m.key === 'h2h');
          if (!market || !market.outcomes) continue;
          
          const homeOutcome = market.outcomes.find(o => o.name === game.home_team);
          const awayOutcome = market.outcomes.find(o => o.name === game.away_team);
          const drawOutcome = market.outcomes.find(o => o.name === 'Draw');
          
          if (!homeOutcome || !awayOutcome) continue;
          
          matchOdds.push({
            team1: game.home_team,
            team2: game.away_team,
            bookmaker: bookmaker.title,
            odds1: parseFloat(homeOutcome.price),
            odds2: parseFloat(awayOutcome.price),
            draw_odds: drawOutcome ? parseFloat(drawOutcome.price) : null,
          });
        }
        
        // Need at least 2 bookmakers to find arbitrage
        if (matchOdds.length >= 2) {
          allMatches.push({
            match_name: `${game.home_team} vs ${game.away_team}`,
            start_time: game.commence_time,
            sport: sport,
            league: sportConfig.display_name,
            odds: matchOdds,
            has_draw: sportConfig.has_draw
          });
        }
      }
      
      console.log(`✅ Processed ${allMatches.length} matches with 2+ bookmakers for ${sport}`);
      return { matches: allMatches, error: null, apiKeyUsed: apiKey };
      
    } catch (error) {
      console.error(`   ❌ ${apiKey} error:`, error.message);
      continue;
    }
  }
  
  // All keys failed
  return { matches: [], error: `No active events found for ${sport}. Season may be off or no matches scheduled.` };
}

/**
 * Find arbitrage opportunities from odds data
 */
function findArbitrageOpportunities(matches, minProfit = 0, stake = 100) {
  const opportunities = [];
  
  for (const match of matches) {
    const arbitrage = match.has_draw 
      ? calculate3WayArbitrage(match.odds)
      : calculate2WayArbitrage(match.odds);
    
    if (arbitrage && arbitrage.exists && arbitrage.profit_percentage >= minProfit) {
      const betsWithStakes = calculateStakeAmounts(arbitrage, stake);
      const guaranteedProfit = (stake * arbitrage.profit_percentage / 100).toFixed(2);
      
      opportunities.push({
        id: `arb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        match: {
          name: match.match_name,
          sport: match.sport,
          league: match.league,
          start_time: match.start_time
        },
        profit_percentage: arbitrage.profit_percentage,
        total_stake: stake,
        guaranteed_profit: guaranteedProfit,
        bets: betsWithStakes,
        detected_at: new Date().toISOString()
      });
    }
  }
  
  // Sort by profit percentage (highest first)
  opportunities.sort((a, b) => b.profit_percentage - a.profit_percentage);
  
  return opportunities;
}

/**
 * Get opportunities (with caching and on-demand scraping)
 */
async function getOpportunities(sport, minProfit = 0, stake = 100) {
  const sportLower = sport.toLowerCase();
  
  // Validate sport
  if (!SPORTS_CONFIG[sportLower]) {
    console.log(`❌ Invalid sport: ${sport}`);
    return { opportunities: [], error: 'Invalid sport' };
  }
  
  // Check cache first
  if (isCacheValid(sportLower)) {
    const cached = cache.data[sportLower];
    const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000 / 60);
    console.log(`✅ Using cached data for ${sport} (${cacheAge} min old)`);
    
    // Filter by minProfit and recalculate stakes if needed
    let opportunities = [...cached.opportunities]; // Clone to avoid mutation
    if (minProfit > 0) {
      opportunities = opportunities.filter(opp => opp.profit_percentage >= minProfit);
    }
    if (stake !== 100) {
      opportunities = opportunities.map(opp => ({
        ...opp,
        total_stake: stake,
        guaranteed_profit: (stake * opp.profit_percentage / 100).toFixed(2),
        bets: opp.bets.map(bet => ({
          ...bet,
          stake_amount: parseFloat((stake * bet.stake_pct / 100).toFixed(2)),
          potential_return: parseFloat((stake * bet.stake_pct / 100 * bet.odds).toFixed(2))
        }))
      }));
    }
    
    return { opportunities, fromCache: true, cacheAge };
  }
  
  // Check if API key is configured
  if (!ODDS_API_KEY) {
    console.log(`⚠️ ODDS_API_KEY not configured`);
    return { 
      opportunities: [], 
      error: 'API not configured',
      message: 'The Odds API key is not configured. Please contact the API administrator.'
    };
  }
  
  // Scrape fresh data
  console.log(`🔄 Cache expired/empty for ${sport}, scraping from The Odds API...`);
  
  try {
    const scrapeResult = await scrapeOddsForSport(sportLower);
    const matches = scrapeResult.matches || [];
    
    console.log(`📊 Scraped ${matches.length} matches for ${sport}`);
    
    // If no matches and there's an error, return it
    if (matches.length === 0 && scrapeResult.error) {
      return { 
        opportunities: [], 
        fromCache: false,
        error: scrapeResult.error,
        message: scrapeResult.error
      };
    }
    
    // Find arbitrage opportunities
    const opportunities = findArbitrageOpportunities(matches, minProfit, stake);
    
    console.log(`💰 Found ${opportunities.length} arbitrage opportunities`);
    
    // Cache the results (with default stake for later filtering)
    const opportunitiesForCache = findArbitrageOpportunities(matches, 0, 100);
    cache.data[sportLower] = {
      opportunities: opportunitiesForCache,
      timestamp: Date.now(),
      matchesScraped: matches.length
    };
    
    console.log(`💾 Cached ${opportunitiesForCache.length} opportunities for ${sport}`);
    
    return { 
      opportunities, 
      fromCache: false, 
      scraped: true,
      matchesAnalyzed: matches.length
    };
    
  } catch (error) {
    console.error(`❌ Error in getOpportunities:`, error);
    return { 
      opportunities: [], 
      error: error.message 
    };
  }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();

// IMPORTANT: Trust Railway's proxy for correct HTTPS detection
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// API KEY MIDDLEWARE (for backward compatibility)
// Must run BEFORE x402 middleware!
// ============================================
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && VALID_API_KEYS.has(apiKey)) {
    req.authMethod = 'api_key';
    console.log(`   🔑 Valid API key, bypassing x402`);
    return next();
  }
  // No valid API key - let x402 handle it
  next();
}

// Check API key BEFORE x402 middleware runs
// This bypasses x402 payment for valid API keys
app.use('/api/opportunities', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && VALID_API_KEYS.has(apiKey)) {
    req.authMethod = 'api_key';
    req.skipX402 = true;
    console.log(`   🔑 API key authenticated: ${apiKey.substring(0, 8)}...`);
  }
  next();
});

// ============================================
// x402 PAYMENT MIDDLEWARE
// ============================================
// Custom wrapper to skip x402 if API key is valid
const x402Routes = {
  'POST /api/opportunities/sport': {
    accepts: [{ scheme: 'exact', price: '$0.03', network: NETWORK, payTo }],
    description: 'Sports betting arbitrage opportunities. Find guaranteed profit across bookmakers for Soccer, Basketball (NBA), Tennis, NFL, or MLB.',
    mimeType: 'application/json',
    extensions: {
      ...declareDiscoveryExtension(bazaarSchema),
    },
  },
  'GET /api/opportunities/sport': {
    accepts: [{ scheme: 'exact', price: '$0.03', network: NETWORK, payTo }],
    description: 'Sports betting arbitrage opportunities. Find guaranteed profit across bookmakers for Soccer, Basketball (NBA), Tennis, NFL, or MLB.',
    mimeType: 'application/json',
    extensions: {
      ...declareDiscoveryExtension(bazaarSchema),
    },
  },
  'GET /api/opportunities/sport/*': {
    accepts: [{ scheme: 'exact', price: '$0.03', network: NETWORK, payTo }],
    description: 'Get arbitrage opportunities for a specific sport (soccer, basketball, tennis, nfl, mlb)',
    mimeType: 'application/json',
  },
};

const x402Handler = paymentMiddleware(x402Routes, resourceServer, undefined, paywall);

// Wrap x402 middleware to skip if API key is present
app.use((req, res, next) => {
  if (req.skipX402) {
    // API key was valid, skip x402 payment check
    return next();
  }
  // No API key, run x402 payment middleware
  x402Handler(req, res, next);
});

// ============================================
// FREE ENDPOINTS (no payment required)
// ============================================

// x402 Discovery Document
app.get('/.well-known/x402', (req, res) => {
  res.json({
    version: 1,
    resources: [
      `${BASE_URL}/api/opportunities/sport`
    ],
    instructions: `# ArbitrageEdge - Sports Betting Arbitrage API

Find guaranteed profit opportunities across multiple bookmakers.

## How to Use
Select a sport from the dropdown and click Fetch. Supported sports:
${SUPPORTED_SPORTS.map(sport => `- **${sport}** (${SPORT_NAMES[sport]})`).join('\n')}

## Pricing
- **$0.03 USDC** per query
- **Network:** Base Mainnet
- **Payment:** Gasless EIP-3009 signatures

## What You Get
- Live arbitrage opportunities for selected sport
- Exact betting instructions (which bookmaker, how much to stake)
- Guaranteed profit percentage regardless of outcome
- Match details and odds

## Support
- Twitter: [@BreakTheCubicle](https://x.com/BreakTheCubicle)
`,
  });
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArbitrageEdge - Sports Betting Arbitrage API</title>
  <meta name="description" content="Real-time sports betting arbitrage API. Pay $0.03 per query with USDC on Base. Find guaranteed profits.">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --cyan: #00D9FF;
      --orange: #FF6B4A;
      --yellow: #FFD93D;
      --green: #00FF88;
      --red: #FF4757;
      --black: #0a0a0a;
    }
    body {
      font-family: 'Space Mono', monospace;
      background: var(--black);
      color: white;
      min-height: 100vh;
      line-height: 1.6;
    }
    .bg-gradient {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;
      background: 
        radial-gradient(circle at 20% 50%, var(--green) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, var(--cyan) 0%, transparent 50%);
      opacity: 0.05;
      animation: gradientShift 20s ease infinite;
    }
    @keyframes gradientShift {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(10%, 10%); }
    }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
    
    .header { text-align: center; margin-bottom: 50px; padding-top: 20px; }
    .logo-text {
      font-family: 'Orbitron', sans-serif;
      font-size: 3rem;
      font-weight: 900;
      background: linear-gradient(135deg, var(--green), var(--cyan), var(--yellow));
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .tagline { font-size: 1.4rem; color: var(--green); font-weight: 700; margin: 10px 0; }
    .subline { color: rgba(255, 255, 255, 0.6); }

    .card {
      background: rgba(26, 26, 26, 0.8);
      border: 2px solid var(--green);
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 25px;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 3px;
      background: linear-gradient(90deg, var(--green), var(--cyan));
    }
    .card-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 1.3rem;
      color: var(--yellow);
      margin-bottom: 20px;
      text-transform: uppercase;
    }

    .cta-section {
      text-align: center;
      padding: 40px;
      background: linear-gradient(135deg, rgba(0, 255, 136, 0.1), rgba(0, 217, 255, 0.1));
      border-radius: 12px;
      border: 2px solid var(--green);
      margin: 30px 0;
    }
    .cta-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 1.8rem;
      color: white;
      margin-bottom: 15px;
    }
    .cta-subtitle { color: rgba(255, 255, 255, 0.7); margin-bottom: 25px; font-size: 1.1rem; }

    .btn {
      padding: 18px 45px;
      font-size: 1.1rem;
      font-weight: 700;
      text-transform: uppercase;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-family: 'Orbitron', sans-serif;
      transition: all 0.3s;
      text-decoration: none;
      display: inline-block;
      margin: 10px;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--green), var(--cyan));
      color: var(--black);
      box-shadow: 0 0 30px rgba(0, 255, 136, 0.5);
    }
    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 0 50px rgba(0, 255, 136, 0.8);
    }
    .btn-secondary {
      background: transparent;
      color: var(--yellow);
      border: 2px solid var(--yellow);
    }
    .btn-secondary:hover { background: var(--yellow); color: var(--black); }

    .badge-row { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; justify-content: center; }
    .badge {
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 700;
      background: rgba(0, 255, 136, 0.1);
      border: 1px solid var(--green);
      color: var(--green);
    }
    .badge-price {
      background: rgba(255, 215, 0, 0.1);
      border-color: var(--yellow);
      color: var(--yellow);
      font-size: 1.1rem;
    }

    .sports { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0; justify-content: center; }
    .sport {
      padding: 10px 20px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 20px;
      font-size: 0.95rem;
      transition: all 0.3s;
    }
    .sport:hover { background: rgba(0, 255, 136, 0.2); border-color: var(--green); }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }
    .stat { text-align: center; padding: 20px; }
    .stat-value {
      font-family: 'Orbitron', sans-serif;
      font-size: 2rem;
      font-weight: 900;
      color: var(--green);
    }
    .stat-label { color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-top: 5px; }

    .endpoint {
      background: rgba(0, 0, 0, 0.4);
      padding: 15px 20px;
      border-radius: 8px;
      margin: 15px 0;
      font-family: 'Space Mono', monospace;
      border-left: 3px solid var(--green);
    }
    .method { color: var(--green); font-weight: 700; }
    .path { color: var(--yellow); }

    .example-response {
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(0, 255, 136, 0.3);
      border-radius: 8px;
      padding: 20px;
      font-size: 0.85rem;
      overflow-x: auto;
      margin-top: 20px;
    }
    .key { color: var(--cyan); }
    .string { color: var(--yellow); }
    .number { color: var(--orange); }

    footer {
      text-align: center;
      margin-top: 50px;
      padding: 30px;
      border-top: 1px solid rgba(0, 255, 136, 0.2);
    }
    .footer-links { display: flex; gap: 25px; justify-content: center; margin-bottom: 20px; flex-wrap: wrap; }
    .footer-links a {
      color: var(--cyan);
      text-decoration: none;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.9rem;
      transition: color 0.3s;
    }
    .footer-links a:hover { color: var(--yellow); }
    .copyright { color: rgba(255, 255, 255, 0.4); font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="bg-gradient"></div>
  
  <div class="container">
    <header class="header">
      <div style="font-size: 4rem; margin-bottom: 15px;">🎯</div>
      <div class="logo-text">ARBITRAGEEDGE</div>
      <p class="tagline">Profit Regardless of the Outcome</p>
      <p class="subline">Sports betting arbitrage API • x402 Protocol • Base Network</p>
    </header>

    <!-- Main CTA -->
    <div class="cta-section">
      <div class="cta-title">🚀 Try It Now</div>
      <p class="cta-subtitle">Pay $0.03 USDC per sport. No subscriptions. No API keys.</p>
      <a href="https://www.x402scan.com/server/7a74d2c7-1275-4192-b334-40fc485de3bd" class="btn btn-primary" target="_blank">
        Try on x402scan →
      </a>
      <a href="/api" class="btn btn-secondary">
        View Docs
      </a>
    </div>

    <!-- Pricing Card -->
    <div class="card">
      <div class="badge-row">
        <span class="badge">⛓️ Base Mainnet</span>
        <span class="badge">💎 USDC</span>
        <span class="badge badge-price">💰 $0.03 / sport</span>
      </div>
      
      <div class="endpoint">
        <span class="method">POST</span> <span class="path">/api/opportunities/sport</span>
      </div>

      <p style="color: rgba(255,255,255,0.8); margin: 20px 0; text-align: center;">Select a sport:</p>
      <div class="sports">
        <span class="sport">⚽ Soccer</span>
        <span class="sport">🏀 Basketball</span>
        <span class="sport">🎾 Tennis</span>
        <span class="sport">🏈 NFL</span>
        <span class="sport">⚾ MLB</span>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats">
      <div class="stat">
        <div class="stat-value">$0.03</div>
        <div class="stat-label">Per Query</div>
      </div>
      <div class="stat">
        <div class="stat-value">5</div>
        <div class="stat-label">Sports</div>
      </div>
      <div class="stat">
        <div class="stat-value">20+</div>
        <div class="stat-label">Bookmakers</div>
      </div>
      <div class="stat">
        <div class="stat-value">100%</div>
        <div class="stat-label">On-chain</div>
      </div>
    </div>

    <!-- Example Response -->
    <div class="card">
      <div class="card-title">📊 Example Response</div>
      <p style="color: rgba(255,255,255,0.7); margin-bottom: 15px;">What you get for $0.03:</p>
      <div class="example-response">
<pre style="margin: 0; color: #e0e0e0;">{
  <span class="key">"sport"</span>: <span class="string">"basketball"</span>,
  <span class="key">"summary"</span>: <span class="string">"🏀 Found 1 arbitrage opportunity in Basketball with avg 2.1% profit"</span>,
  
  <span class="key">"opportunities"</span>: [{
    <span class="key">"match"</span>: <span class="string">"Lakers vs Celtics"</span>,
    <span class="key">"profit"</span>: <span class="string">"2.1% guaranteed"</span>,
    <span class="key">"instructions"</span>: <span class="string">"Bet $47.62 on Lakers @ 2.10 (DraftKings) | Bet $52.38 on Celtics @ 1.95 (FanDuel)"</span>,
    <span class="key">"total_stake"</span>: <span class="number">$100</span>,
    <span class="key">"guaranteed_return"</span>: <span class="number">$102.10</span>
  }]
}</pre>
      </div>
    </div>

    <!-- What You Get -->
    <div class="card">
      <div class="card-title">✨ What You Get</div>
      <ul style="padding-left: 25px; line-height: 2.2; color: rgba(255,255,255,0.85);">
        <li><span style="color: var(--green)">✓</span> Human-readable summary with profit percentage</li>
        <li><span style="color: var(--green)">✓</span> Exact betting instructions (bookmaker + stake amount)</li>
        <li><span style="color: var(--green)">✓</span> Guaranteed profit regardless of game outcome</li>
        <li><span style="color: var(--green)">✓</span> Multiple opportunities per sport when available</li>
        <li><span style="color: var(--green)">✓</span> Real-time odds from 20+ bookmakers</li>
      </ul>
    </div>

    <!-- Free Endpoints -->
    <div class="card">
      <div class="card-title">🆓 Free Endpoints</div>
      <div class="endpoint">
        <span class="method">GET</span> <span class="path">/health</span> — Health check
      </div>
      <div class="endpoint">
        <span class="method">GET</span> <span class="path">/api</span> — API documentation
      </div>
      <div class="endpoint">
        <span class="method">GET</span> <span class="path">/api/opportunities/sports/list</span> — List sports
      </div>
    </div>

    <footer>
      <div class="footer-links">
        <a href="https://x.com/BreakTheCubicle" target="_blank">Twitter</a>
        <a href="https://www.x402scan.com/server/7a74d2c7-1275-4192-b334-40fc485de3bd" target="_blank">x402scan</a>
        <a href="https://x402.org" target="_blank">x402 Protocol</a>
        <a href="https://base.org" target="_blank">Base</a>
      </div>
      <p class="copyright">© 2026 ArbitrageEdge • Built with x402 on Base</p>
    </footer>
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
        '/api/opportunities/sport/:sport': '$0.03 per sport'
      }
    },
    endpoints: {
      'GET /api/opportunities/sport/:sport': {
        description: 'Get arbitrage opportunities for a specific sport',
        price: '$0.03 USDC',
        sports: ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'],
        query_params: { min_profit: 'number', stake: 'number' }
      },
      'GET /api/opportunities/sports/list': {
        description: 'List supported sports',
        price: 'FREE'
      }
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

// POST /api/opportunities/sport - x402scan sends sport in body (dropdown selection)
app.post('/api/opportunities/sport', async (req, res) => {
  // authMethod already set by API key middleware if valid
  if (!req.authMethod) req.authMethod = 'x402';
  
  console.log('\n📥 POST /api/opportunities/sport received:');
  console.log('   Body:', JSON.stringify(req.body));
  console.log('   Query:', JSON.stringify(req.query));
  
  // Try multiple ways to get the sport parameter
  let sport = 'soccer'; // default
  
  if (req.body?.sport) {
    sport = req.body.sport;
    console.log('   Found sport in body:', sport);
  } else if (typeof req.body === 'string') {
    sport = req.body;
    console.log('   Found sport as body string:', sport);
  } else if (req.query?.sport) {
    sport = req.query.sport;
    console.log('   Found sport in query:', sport);
  } else if (req.body?.input?.sport) {
    sport = req.body.input.sport;
    console.log('   Found sport in body.input:', sport);
  } else {
    console.log('   No sport found, using default soccer');
  }
  
  const minProfit = req.query.min_profit ? parseFloat(req.query.min_profit) : 0;
  const stake = req.query.stake ? parseFloat(req.query.stake) : 100;
  
  const validSports = ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'];
  if (!validSports.includes(sport.toLowerCase())) {
    console.log(`   ❌ Invalid sport: ${sport}`);
    return res.status(400).json({ 
      success: false, 
      error: `Invalid sport: ${sport}`,
      valid_options: validSports
    });
  }
  
  try {
    // Get real opportunities (with caching)
    console.log(`   🔍 Getting opportunities for ${sport}...`);
    const result = await getOpportunities(sport, minProfit, stake);
    const opportunities = result.opportunities || [];
    
    console.log(`   📊 Result: ${opportunities.length} opportunities`);
    
    // Sport emoji mapping
    const sportEmoji = { soccer: '⚽', basketball: '🏀', tennis: '🎾', nfl: '🏈', mlb: '⚾' };
    const emoji = sportEmoji[sport.toLowerCase()] || '🎯';
    const sportDisplay = sport.charAt(0).toUpperCase() + sport.slice(1).toLowerCase();
    
    // Calculate average profit
    const avgProfit = opportunities.length > 0 
      ? (opportunities.reduce((sum, opp) => sum + opp.profit_percentage, 0) / opportunities.length).toFixed(1)
      : '0';
    
    // Data source info
    let dataSource = 'The Odds API';
    if (result.fromCache) {
      dataSource = `cached (${result.cacheAge} min old)`;
    } else if (result.error) {
      dataSource = `error: ${result.error}`;
    }
    
    // Create human-readable summary
    let summary;
    if (result.error === 'API not configured') {
      summary = `⚠️ API not configured. Please set ODDS_API_KEY in environment variables.`;
    } else if (opportunities.length > 0) {
      summary = `${emoji} Found ${opportunities.length} arbitrage opportunit${opportunities.length === 1 ? 'y' : 'ies'} in ${sportDisplay} with avg ${avgProfit}% guaranteed profit`;
    } else {
      summary = `${emoji} No arbitrage opportunities currently available for ${sportDisplay}. This is normal - true arbitrage opportunities are rare and short-lived. Try again later or check another sport.`;
    }
    
    // Format opportunities for easier reading
    const formattedOpportunities = opportunities.map(opp => ({
      match: opp.match?.name || 'Unknown',
      league: opp.match?.league || SPORTS_CONFIG[sport.toLowerCase()]?.display_name || sport,
      profit: `${opp.profit_percentage}% guaranteed`,
      guaranteed_profit: `$${opp.guaranteed_profit}`,
      total_stake: `$${stake}`,
      instructions: opp.bets?.map(bet => 
        `${bet.outcome}: $${bet.stake_amount} @ ${bet.odds} on ${bet.bookmaker}`
      ).join(' | ') || 'N/A',
      start_time: opp.match?.start_time || null,
      id: opp.id
    }));
    
    const response = {
      success: true,
      sport: sport.toLowerCase(),
      summary,
      count: opportunities.length,
      avg_profit: opportunities.length > 0 ? `${avgProfit}%` : 'N/A',
      opportunities: formattedOpportunities,
      data_source: dataSource,
      auth_method: req.authMethod,
      price_paid: '$0.03 USDC',
      timestamp: new Date().toISOString()
    };
    
    console.log(`   ✅ Sending response with ${opportunities.length} opportunities`);
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error fetching opportunities:', error);
    res.status(500).json({
      success: false,
      sport: sport.toLowerCase(),
      error: 'Failed to fetch opportunities',
      message: error.message,
      summary: `❌ Error fetching ${sport} opportunities: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/opportunities/sport - for x402scan testing (defaults to soccer)
app.get('/api/opportunities/sport', async (req, res) => {
  if (!req.authMethod) req.authMethod = 'x402';
  
  console.log('\n📥 GET /api/opportunities/sport received:');
  console.log('   Query:', JSON.stringify(req.query));
  
  const sport = req.query?.sport || 'soccer';
  const minProfit = req.query.min_profit ? parseFloat(req.query.min_profit) : 0;
  const stake = req.query.stake ? parseFloat(req.query.stake) : 100;
  
  try {
    const result = await getOpportunities(sport, minProfit, stake);
    const opportunities = result.opportunities;
    
    const avgProfit = opportunities.length > 0 
      ? (opportunities.reduce((sum, opp) => sum + opp.profit_percentage, 0) / opportunities.length).toFixed(1)
      : 0;
    
    const sportEmoji = { soccer: '⚽', basketball: '🏀', tennis: '🎾', nfl: '🏈', mlb: '⚾' };
    const emoji = sportEmoji[sport.toLowerCase()] || '🎯';
    
    const dataSource = result.mock ? 'mock (API unavailable)' : 
                       result.fromCache ? `cache (${result.cacheAge} min old)` : 
                       'live (The Odds API)';
    
    const summary = opportunities.length > 0
      ? `${emoji} Found ${opportunities.length} arbitrage opportunit${opportunities.length === 1 ? 'y' : 'ies'} in ${sport.charAt(0).toUpperCase() + sport.slice(1)} with avg ${avgProfit}% guaranteed profit`
      : `${emoji} No arbitrage opportunities currently available for ${sport}. Check back soon!`;
    
    const formattedOpportunities = opportunities.map(opp => ({
      match: opp.match.name,
      league: opp.match.league,
      profit: `${opp.profit_percentage}% guaranteed`,
      guaranteed_profit: `$${opp.guaranteed_profit}`,
      total_stake: `$${stake}`,
      instructions: opp.bets.map(bet => 
        `${bet.outcome}: $${bet.stake_amount} @ ${bet.odds} on ${bet.bookmaker}`
      ).join(' | '),
      start_time: opp.match.start_time,
      id: opp.id
    }));
    
    res.json({
      success: true,
      sport: sport.toLowerCase(),
      summary,
      count: opportunities.length,
      avg_profit: `${avgProfit}%`,
      opportunities: formattedOpportunities,
      data_source: dataSource,
      auth_method: req.authMethod,
      price_paid: '$0.03 USDC',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/opportunities/sport/:sport - URL-based access (backwards compatible)
app.get('/api/opportunities/sport/:sport', async (req, res) => {
  if (!req.authMethod) req.authMethod = 'x402';
  
  const { sport } = req.params;
  const minProfit = req.query.min_profit ? parseFloat(req.query.min_profit) : 0;
  const stake = req.query.stake ? parseFloat(req.query.stake) : 100;
  
  const validSports = ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'];
  if (!validSports.includes(sport.toLowerCase())) {
    return res.status(400).json({ 
      success: false, 
      error: `Invalid sport. Valid options: ${validSports.join(', ')}` 
    });
  }
  
  try {
    const result = await getOpportunities(sport, minProfit, stake);
    const opportunities = result.opportunities;
    
    const avgProfit = opportunities.length > 0 
      ? (opportunities.reduce((sum, opp) => sum + opp.profit_percentage, 0) / opportunities.length).toFixed(1)
      : 0;
    
    const sportEmoji = { soccer: '⚽', basketball: '🏀', tennis: '🎾', nfl: '🏈', mlb: '⚾' };
    const emoji = sportEmoji[sport.toLowerCase()] || '🎯';
    
    const dataSource = result.mock ? 'mock (API unavailable)' : 
                       result.fromCache ? `cache (${result.cacheAge} min old)` : 
                       'live (The Odds API)';
    
    const summary = opportunities.length > 0
      ? `${emoji} Found ${opportunities.length} arbitrage opportunit${opportunities.length === 1 ? 'y' : 'ies'} in ${sport.charAt(0).toUpperCase() + sport.slice(1)} with avg ${avgProfit}% guaranteed profit`
      : `${emoji} No arbitrage opportunities currently available for ${sport}. Check back soon!`;
    
    const formattedOpportunities = opportunities.map(opp => ({
      match: opp.match.name,
      league: opp.match.league,
      profit: `${opp.profit_percentage}% guaranteed`,
      guaranteed_profit: `$${opp.guaranteed_profit}`,
      total_stake: `$${stake}`,
      instructions: opp.bets.map(bet => 
        `${bet.outcome}: $${bet.stake_amount} @ ${bet.odds} on ${bet.bookmaker}`
      ).join(' | '),
      start_time: opp.match.start_time,
      id: opp.id
    }));
    
    res.json({
      success: true,
      sport: sport.toLowerCase(),
      summary,
      count: opportunities.length,
      avg_profit: `${avgProfit}%`,
      opportunities: formattedOpportunities,
      data_source: dataSource,
      auth_method: req.authMethod,
      price_paid: '$0.03 USDC',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Redirect to sport selection (no longer a paid endpoint)
app.get('/api/opportunities', (req, res) => {
  res.json({
    success: false,
    message: 'Please select a sport',
    endpoint: '/api/opportunities/sport/:sport',
    price: '$0.03 USDC',
    available_sports: ['soccer', 'basketball', 'tennis', 'nfl', 'mlb'],
    example: '/api/opportunities/sport/soccer'
  });
});

// Get specific opportunity by ID (free lookup if you have the ID)
app.get('/api/opportunities/:id', (req, res) => {
  const { id } = req.params;
  const { stake } = req.query;
  const allOpps = generateMockOpportunities(null, null, stake ? parseFloat(stake) : null);
  const opportunity = allOpps.find(opp => opp.id === id);
  
  if (!opportunity) {
    return res.status(404).json({ success: false, error: 'Opportunity not found or expired' });
  }
  
  res.json({ success: true, opportunity });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  const oddsApiStatus = ODDS_API_KEY ? '✅ Connected' : '⚠️ Not set (using mock data)';
  
  console.log(`
============================================
🎯 ArbitrageEdge API with x402
============================================
💰 Pricing: $0.03 USDC per sport query
💳 Network: Base Mainnet (eip155:8453)
💵 Wallet: ${payTo}
🔑 API Keys: ${VALID_API_KEYS.size} configured

📊 Data Source: The Odds API
   Status: ${oddsApiStatus}
   Cache: 30 minutes

🌐 Server: http://localhost:${PORT}
📡 API: http://localhost:${PORT}/api
💚 Health: http://localhost:${PORT}/health
============================================
  `);
});
