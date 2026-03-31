/**
 * RSI 10-minute scalping bot (Samsung Electronics only)
 *
 * Safety defaults:
 * - Uses KIWOOM_IS_MOCK=true unless you explicitly set false in .env
 * - Single position at a time
 * - Minimal sizing (default 1 share)
 *
 * Run once:
 *   node --env-file=.env rsi_scalp_bot.js
 * Loop every 30 min:
 *   node --env-file=.env rsi_scalp_bot.js --loop
 */

const fs = require('fs');
const path = require('path');
const KiwoomClient = require('./kiwoom_api');

const STOCK_CODE = '005930';
const TIC_SCOPE = '10';
const RSI_PERIOD = 14;

// Strategy params (scale-in / scale-out)
// Scale-in when RSI gets oversold; scale-out on rebound.
// NOTE: quantities are small by default for safety.
const BUY_LADDER = [
  { rsiMax: 30, qty: 1 },
  { rsiMax: 25, qty: 1 },
  { rsiMax: 20, qty: 1 }
];

const SELL_LADDER = [
  { rsiMin: 55, fraction: 1 / 3 },
  { rsiMin: 62, fraction: 1 / 3 },
  { rsiMin: 70, fraction: 1 / 3 }
];

// Hard risk controls (apply regardless of ladder)
const TAKE_PROFIT_PCT = 0.6; // +0.6% from avg entry
const STOP_LOSS_PCT = -0.5;  // -0.5% from avg entry

// Cooldown to avoid rapid re-entries (ms)
const COOLDOWN_AFTER_TRADE_MS = 5 * 60 * 1000;

const STATE_PATH = path.join(__dirname, 'bot_state.json');
const LOG_DIR = path.join(__dirname, 'logs');
const RUNS_LOG_PATH = path.join(LOG_DIR, 'runs.jsonl');
const TRADES_LOG_PATH = path.join(LOG_DIR, 'trades.jsonl');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSignedNumber(s) {
  // e.g. "+207000", "000000099999147", "-00000000002100"
  if (typeof s !== 'string') return NaN;
  const cleaned = s.trim().replace(/,/g, '');
  // keep leading + or - if present
  const sign = cleaned.startsWith('-') ? -1 : 1;
  const digits = cleaned.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  return sign * Number(digits);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      lastAction: null,
      lastRunAt: null,
      lastTradeAt: null,
      // how many ladder legs have been executed in the current position cycle
      buyLegsDone: 0,
      sellLegsDone: 0,
      notes: "",
    };
  }
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureLogDir();
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return { rsi: null, reason: `need >= ${period + 1} closes` };
  }

  let gains = 0;
  let losses = 0;

  // initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += -change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return { rsi: 100, reason: null };
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return { rsi, reason: null };
}

async function getAccountNo(client) {
  const res = await client.getAccounts();
  if (!res.success) throw new Error(`getAccounts failed: ${JSON.stringify(res.body)}`);
  const acctNo = res.body?.acctNo;
  if (!acctNo) throw new Error(`No acctNo in response: ${JSON.stringify(res.body)}`);
  return acctNo;
}

async function getPosition(client, accountNo) {
  const res = await client.getAccountBalance(accountNo);
  if (!res.success) throw new Error(`getAccountBalance failed: ${JSON.stringify(res.body)}`);

  const items = res.body?.acnt_evlt_remn_indv_tot || [];
  const row = items.find((x) => (x.stk_cd || '').endsWith(STOCK_CODE));
  if (!row) {
    return {
      hasPosition: false,
      qty: 0,
      avgEntryPrice: null,
      raw: res.body,
    };
  }

  const qty = parseSignedNumber(row.rmnd_qty);

  // In mock, pur_pric looks like per-share avg purchase price.
  // If it's not reliable, we can fall back to (pur_amt / qty).
  let avgEntryPrice = parseSignedNumber(row.pur_pric);
  if (!Number.isFinite(avgEntryPrice) || avgEntryPrice <= 0) {
    const purAmt = parseSignedNumber(row.pur_amt);
    avgEntryPrice = qty > 0 ? purAmt / qty : null;
  }

  return {
    hasPosition: qty > 0,
    qty,
    avgEntryPrice,
    row,
    raw: res.body,
  };
}

async function getLatestCloses(client) {
  const res = await client.getMinuteChart(STOCK_CODE, TIC_SCOPE);
  if (!res.success) throw new Error(`getMinuteChart failed: ${JSON.stringify(res.body)}`);
  const rows = res.body?.stk_min_pole_chart_qry || [];
  // API returns newest-first; sort oldest->newest
  const sorted = [...rows].sort((a, b) => (a.cntr_tm || '').localeCompare(b.cntr_tm || ''));
  const closes = sorted
    .map((r) => parseSignedNumber(r.cur_prc))
    .filter((n) => Number.isFinite(n) && n > 0);
  const times = sorted.map((r) => r.cntr_tm);
  return { closes, times, rawRows: rows };
}

function pctChange(current, entry) {
  return ((current - entry) / entry) * 100;
}

async function runOnce() {
  const state = loadState();

  const client = new KiwoomClient({
    appKey: process.env.KIWOOM_APP_KEY,
    appSecret: process.env.KIWOOM_APP_SECRET,
    isMock: process.env.KIWOOM_IS_MOCK !== 'false',
  });

  await client.issueToken();
  const accountNo = await getAccountNo(client);

  const { closes, times } = await getLatestCloses(client);
  const { rsi } = computeRSI(closes.slice(- (RSI_PERIOD + 20)), RSI_PERIOD);

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const lastTime = times[times.length - 1];

  const pos = await getPosition(client, accountNo);

  // reset ladder counters if flat
  if (!pos.hasPosition && (state.buyLegsDone !== 0 || state.sellLegsDone !== 0)) {
    state.buyLegsDone = 0;
    state.sellLegsDone = 0;
  }

  const snapshot = {
    at: new Date().toISOString(),
    isMock: client.isMock,
    accountNo,
    candleTime: lastTime,
    last,
    prev,
    rsi: rsi == null ? null : Number(rsi.toFixed(2)),
    hasPosition: pos.hasPosition,
    qty: pos.qty,
    avgEntryPrice: pos.avgEntryPrice,
    buyLegsDone: state.buyLegsDone,
    sellLegsDone: state.sellLegsDone,
  };

  console.log('[BOT] Snapshot:', JSON.stringify(snapshot, null, 2));
  appendJsonl(RUNS_LOG_PATH, { type: 'snapshot', ...snapshot });

  let action = { type: 'none', reason: '' };

  const now = Date.now();
  const inCooldown = state.lastTradeAt && now - new Date(state.lastTradeAt).getTime() < COOLDOWN_AFTER_TRADE_MS;

  if (!Number.isFinite(last) || !Number.isFinite(prev) || rsi == null) {
    action = { type: 'none', reason: 'insufficient candle data for RSI' };
  } else if (!pos.hasPosition) {
    // Scale-in cycle starts from flat.
    const rebound = last > prev;
    const nextLeg = BUY_LADDER[state.buyLegsDone];

    if (inCooldown) {
      action = { type: 'hold', reason: 'cooldown-after-trade' };
    } else if (nextLeg && rsi <= nextLeg.rsiMax && rebound) {
      const res = await client.buyStock({
        stockCode: STOCK_CODE,
        quantity: nextLeg.qty,
        price: '',
        tradeType: '03',
      });
      state.buyLegsDone += 1;
      state.lastTradeAt = new Date().toISOString();
      action = { type: 'buy', leg: state.buyLegsDone, qty: nextLeg.qty, rsi: Number(rsi.toFixed(2)), ord: res.body };
      console.log('[BOT] BUY result:', JSON.stringify(res.body, null, 2));
    } else {
      action = { type: 'hold', reason: `flat (rsi=${rsi.toFixed(2)}, rebound=${rebound}, nextBuyLeg=${state.buyLegsDone + 1})` };
    }
  } else {
    const entry = pos.avgEntryPrice;
    const chg = pctChange(last, entry);

    // Hard exits override ladder
    if (!inCooldown && (chg >= TAKE_PROFIT_PCT || chg <= STOP_LOSS_PCT)) {
      const res = await client.sellStock({
        stockCode: STOCK_CODE,
        quantity: pos.qty,
        price: '',
        tradeType: '03',
      });
      state.sellLegsDone = SELL_LADDER.length;
      state.lastTradeAt = new Date().toISOString();
      action = {
        type: 'sell-all',
        qty: pos.qty,
        changePct: Number(chg.toFixed(3)),
        rsi: Number(rsi.toFixed(2)),
        ord: res.body,
      };
      console.log('[BOT] SELL-ALL result:', JSON.stringify(res.body, null, 2));
    } else {
      // Scale-out based on RSI thresholds
      const nextSellLeg = SELL_LADDER[state.sellLegsDone];
      if (!inCooldown && nextSellLeg && rsi >= nextSellLeg.rsiMin) {
        const rawQty = Math.floor(pos.qty * nextSellLeg.fraction);
        const sellQty = Math.max(1, rawQty);
        const qty = Math.min(sellQty, pos.qty);

        const res = await client.sellStock({
          stockCode: STOCK_CODE,
          quantity: qty,
          price: '',
          tradeType: '03',
        });
        state.sellLegsDone += 1;
        state.lastTradeAt = new Date().toISOString();
        action = {
          type: 'sell',
          leg: state.sellLegsDone,
          qty,
          changePct: Number(chg.toFixed(3)),
          rsi: Number(rsi.toFixed(2)),
          ord: res.body,
        };
        console.log('[BOT] SELL result:', JSON.stringify(res.body, null, 2));
      } else {
        action = {
          type: 'hold',
          reason: `in-position (chg=${chg.toFixed(3)}%, rsi=${rsi.toFixed(2)}, nextSellLeg=${state.sellLegsDone + 1})`,
        };
      }
    }
  }

  state.lastRunAt = new Date().toISOString();
  state.lastAction = action;
  saveState(state);

  console.log('[BOT] Action:', JSON.stringify(action, null, 2));
  appendJsonl(RUNS_LOG_PATH, {
    type: 'action',
    at: new Date().toISOString(),
    accountNo,
    isMock: client.isMock,
    stockCode: STOCK_CODE,
    action,
  });

  if (['buy', 'sell', 'sell-all'].includes(action.type)) {
    appendJsonl(TRADES_LOG_PATH, {
      type: action.type,
      at: new Date().toISOString(),
      accountNo,
      isMock: client.isMock,
      stockCode: STOCK_CODE,
      candleTime: lastTime,
      last,
      rsi: rsi == null ? null : Number(rsi.toFixed(2)),
      details: action,
    });
  }
}

async function loop() {
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error('[BOT] Error:', e);
    }

    // run every 30 minutes; simple fixed sleep to avoid over-calling.
    await sleep(30 * 60 * 1000);
  }
}

(async function main() {
  const args = process.argv.slice(2);
  const isLoop = args.includes('--loop');
  if (isLoop) {
    console.log('[BOT] Starting loop mode (every 10 minutes).');
    await loop();
  } else {
    await runOnce();
  }
})();
