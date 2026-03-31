const fs = require('fs');
const KiwoomClient = require('./kiwoom_api');

/**
 * RSI (Relative Strength Index) 계산 - Wilder's Smoothing 방식
 * @param {number[]} prices - 종목 가격 배열 (최신 데이터가 마지막)
 * @param {number} period - 기간 (기본 14)
 */
function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return null;

  let gains = [];
  let losses = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

class AutoTrader {
  constructor(options) {
    this.client = new KiwoomClient(options);
    this.stockCode = '005930'; // 삼성전자 고정
    this.positionPath = './position.json';
    this.state = this.loadState();
    this.maxPositionRatio = 0.1; // 예수금의 10%
    this.takeProfit = 0.004; // +0.4%
    this.stopLoss = -0.003; // -0.3%
    this.timeCutMinutes = 60; // 60분 타임컷
    this.dailyLossLimit = -0.01; // 하루 최대 손실 -1.0%
    this.dailyStopCount = 3; // 연속 3번 손절 시 중단
  }

  loadState() {
    if (fs.existsSync(this.positionPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.positionPath, 'utf8'));
      } catch (e) {
        console.error('State load error:', e);
      }
    }
    return {
      hasPosition: false,
      entryPrice: 0,
      quantity: 0,
      entryTime: null,
      dailyLoss: 0,
      consecutiveLosses: 0,
      totalPnL: 0,
      lastTradeDate: new Date().toISOString().split('T')[0]
    };
  }

  saveState() {
    fs.writeFileSync(this.positionPath, JSON.stringify(this.state, null, 2));
  }

  resetDailyState() {
    const today = new Date().toISOString().split('T')[0];
    if (this.state.lastTradeDate !== today) {
      this.state.dailyLoss = 0;
      this.state.consecutiveLosses = 0;
      this.state.lastTradeDate = today;
      this.saveState();
      console.log(`[${today}] Daily state reset.`);
    }
  }

  async run() {
    console.log('--- Kiwoom AutoTrader Starting ---');
    
    // 1. 인증
    const auth = await this.client.issueToken();
    if (!auth.success) return;

    // 초기 상태 체크
    this.resetDailyState();

    // 10분마다 실행 스케줄러 (다음 10분 단위 마다 실행)
    this.scheduleNextRun();
  }

  scheduleNextRun() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    
    // 다음 10분 단위 (0, 10, 20, 30, 40, 50분) + 10초 여유
    const nextMinutes = (Math.floor(minutes / 10) + 1) * 10;
    const delay = ((nextMinutes - minutes) * 60 - seconds + 10) * 1000;

    console.log(`Next execution scheduled in ${Math.round(delay / 1000)}s (at ${nextMinutes} min mark)`);
    setTimeout(() => this.executeStrategy(), delay);
  }

  async executeStrategy() {
    try {
      console.log(`\n[${new Date().toLocaleTimeString()}] Executing Strategy...`);
      this.resetDailyState();

      // 안전장치 체크
      if (this.state.dailyLoss <= this.dailyLossLimit) {
        console.log('Daily loss limit reached. Stopping for today.');
        this.scheduleNextRun();
        return;
      }
      if (this.state.consecutiveLosses >= this.dailyStopCount) {
        console.log('Consecutive loss limit reached. Stopping for today.');
        this.scheduleNextRun();
        return;
      }

      // 1. 데이터 수집 (10분봉)
      const chartRes = await this.client.getMinuteChart(this.stockCode, '10');
      
      // 키움 REST API 응답 구조: stk_min_pole_chart_qry 배열에 데이터가 담겨옴
      const candles = chartRes.body.stk_min_pole_chart_qry;
      
      if (!chartRes.success || !candles || !Array.isArray(candles)) {
        console.error('Failed to get chart data or invalid format:', chartRes.body);
        this.scheduleNextRun();
        return;
      }

      // 최신 데이터가 배열의 앞에 오므로 reverse()하여 인덱스 0이 과거가 되도록 정렬
      // 가격 필드는 'cur_prc' (현재가/종가) 사용
      const prices = candles.map(c => Math.abs(parseInt(c.cur_prc))).reverse();
      
      const currentPrice = prices[prices.length - 1];
      const prevPrice = prices[prices.length - 2];
      const rsi = calculateRSI(prices, 14);

      console.log(`Current: ${currentPrice}, Prev: ${prevPrice}, RSI: ${rsi?.toFixed(2)}`);

      if (this.state.hasPosition) {
        await this.checkExit(currentPrice);
      } else {
        await this.checkEntry(currentPrice, prevPrice, rsi);
      }

    } catch (error) {
      console.error('Strategy execution error:', error);
    } finally {
      this.saveState();
      this.scheduleNextRun();
    }
  }

  async checkEntry(currentPrice, prevPrice, rsi) {
    if (rsi === null) return;

    // 진입 조건: RSI <= 28 AND 현재가 > 이전가 (반등 확인)
    if (rsi <= 28 && currentPrice > prevPrice) {
      console.log('--- ENTRY SIGNAL ---');
      
      // 예수금 확인
      const accRes = await this.client.getAccounts();
      if (!accRes.success || !accRes.body.out?.[0]) return;
      
      const accNo = accRes.body.out[0].accNo;
      const depRes = await this.client.getDepositDetails(accNo);
      if (!depRes.success) return;
      
      // d+2 예수금 기준
      const deposit = parseInt(depRes.body.output.d2_dn_mny_rest_amt || depRes.body.output.d2_mny);
      const buyBudget = deposit * this.maxPositionRatio;
      const quantity = Math.floor(buyBudget / currentPrice);

      if (quantity > 0) {
        console.log(`Buying ${quantity} shares at ${currentPrice}`);
        const orderRes = await this.client.buyStock({
          stockCode: this.stockCode,
          quantity: quantity,
          tradeType: '03' // 시장가
        });

        if (orderRes.success) {
          this.state.hasPosition = true;
          this.state.entryPrice = currentPrice;
          this.state.quantity = quantity;
          this.state.entryTime = Date.now();
          console.log('Buy order submitted successfully');
        } else {
          console.error('Buy order failed:', orderRes.body);
        }
      }
    }
  }

  async checkExit(currentPrice) {
    const pnlRatio = (currentPrice - this.state.entryPrice) / this.state.entryPrice;
    const holdTimeMinutes = (Date.now() - this.state.entryTime) / (1000 * 60);

    let shouldExit = false;
    let exitReason = '';

    if (pnlRatio >= this.takeProfit) {
      shouldExit = true;
      exitReason = 'Take Profit';
    } else if (pnlRatio <= this.stopLoss) {
      shouldExit = true;
      exitReason = 'Stop Loss';
    } else if (holdTimeMinutes >= this.timeCutMinutes) {
      shouldExit = true;
      exitReason = 'Time Cut';
    }

    if (shouldExit) {
      console.log(`--- EXIT SIGNAL (${exitReason}) ---`);
      console.log(`Selling ${this.state.quantity} shares at ${currentPrice} (PnL: ${(pnlRatio * 100).toFixed(2)}%)`);
      
      const orderRes = await this.client.sellStock({
        stockCode: this.stockCode,
        quantity: this.state.quantity,
        tradeType: '03' // 시장가
      });

      if (orderRes.success) {
        // 통계 업데이트
        this.state.totalPnL += pnlRatio;
        if (pnlRatio < 0) {
          this.state.dailyLoss += pnlRatio;
          this.state.consecutiveLosses += 1;
        } else {
          this.state.consecutiveLosses = 0;
        }

        this.state.hasPosition = false;
        this.state.entryPrice = 0;
        this.state.quantity = 0;
        this.state.entryTime = null;
        console.log('Sell order submitted successfully');
      } else {
        console.error('Sell order failed:', orderRes.body);
      }
    }
  }
}

// 환경변수가 로드된 상태에서 실행
if (require.main === module) {
  const trader = new AutoTrader({
    appKey: process.env.KIWOOM_APP_KEY,
    appSecret: process.env.KIWOOM_APP_SECRET,
    isMock: process.env.KIWOOM_IS_MOCK !== 'false'
  });
  trader.run();
}

module.exports = AutoTrader;
