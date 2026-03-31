const http = require('https');

/**
 * 키움증권 REST API 클라이언트
 * Node.js 18+ 이상 (내장 fetch 사용 시) 또는 http/https 모듈 사용 가능
 */
class KiwoomClient {
  static TR_IDS = {
    TOKEN: 'au10001',
    ACCOUNT_LIST: 'ka00001',
    EVALUATION_STATUS: 'kt00004',
    DEPOSIT_DETAILS: 'kt00001',
    BALANCE_DETAILS: 'kt00018',
    STOCK_QUOTE: 'ka10004',
    MINUTE_CHART: 'ka10080',
    BUY_ORDER: 'kt10000',
    SELL_ORDER: 'kt10001'
  };

  /**
   * @param {Object} options
   * @param {string} options.appKey - API 앱키
   * @param {string} options.appSecret - API 앱시크릿
   * @param {boolean} [options.isMock=false] - 모의투자 여부
   */
  constructor({ appKey, appSecret, isMock = false }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.isMock = isMock;
    this.baseUrl = isMock ? 'https://mockapi.kiwoom.com' : 'https://api.kiwoom.com';
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * 1. 접근토큰 발급 (au10001)
   */
  async issueToken() {
    console.log(`[Kiwoom] Issuing token to ${this.baseUrl}`);
    
    try {
      const response = await fetch(`${this.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8'
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: this.appKey,
          secretkey: this.appSecret
        })
      });

      const data = await response.json();

      if (response.ok && data.token) {
        this.accessToken = data.token;
        // 토큰 만료 시간 설정 (보통 24시간이나 넉넉하게 23시간으로 설정)
        this.tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);
        console.log('[Kiwoom] Token issued successfully');
        return { success: true, data };
      } else {
        console.error('[Kiwoom] Token generation failed:', data);
        return { success: false, error: data };
      }
    } catch (error) {
      console.error('[Kiwoom] Network error during token issuance:', error);
      throw error;
    }
  }

  /**
   * 공통 API 호출 헬퍼
   */
  async _callApi({ endpoint, apiId, params = {}, contYn = 'N', nextKey = '' }) {
    if (!this.accessToken) {
      throw new Error('Authentication token is missing. Call issueToken() first.');
    }

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${this.accessToken}`,
      'cont-yn': contYn,
      'next-key': nextKey,
      'api-id': apiId
    };

    console.log(`[Kiwoom API] Calling ${apiId} (${endpoint})`);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(params)
      });

      const body = await response.json();
      
      return {
        statusCode: response.status,
        success: response.ok,
        body,
        contYn: response.headers.get('cont-yn'),
        nextKey: response.headers.get('next-key')
      };
    } catch (error) {
      console.error(`[Kiwoom API] Error calling ${apiId}:`, error);
      throw error;
    }
  }

  /**
   * 2. 계좌번호 조회 (ka00001)
   */
  async getAccounts() {
    return this._callApi({
      endpoint: '/api/dostk/acnt',
      apiId: KiwoomClient.TR_IDS.ACCOUNT_LIST
    });
  }

  /**
   * 3. 계좌 평가 현황 (kt00004) - 총 자산 정보
   */
  async getAccountEvaluation(accountNo) {
    return this._callApi({
      endpoint: '/api/dostk/acnt',
      apiId: KiwoomClient.TR_IDS.EVALUATION_STATUS,
      params: {
        accNo: accountNo,
        itg_accNo: accountNo,
        pw: '',
        qry_tp: '2', // 상세
        dmst_stex_tp: 'KRX',
        f_id: ''
      }
    });
  }

  /**
   * 4. 예수금 상세 현황 (kt00001)
   */
  async getDepositDetails(accountNo) {
    return this._callApi({
      endpoint: '/api/dostk/acnt',
      apiId: KiwoomClient.TR_IDS.DEPOSIT_DETAILS,
      params: {
        accNo: accountNo,
        itg_accNo: accountNo,
        pw: '',
        qry_tp: '2',
        dmst_stex_tp: 'KRX'
      }
    });
  }

  /**
   * 5. 계좌 평가 잔고 내역 (kt00018) - 종목별 상세
   */
  async getAccountBalance(accountNo) {
    return this._callApi({
      endpoint: '/api/dostk/acnt',
      apiId: KiwoomClient.TR_IDS.BALANCE_DETAILS,
      params: {
        accNo: accountNo,
        itg_accNo: accountNo,
        pw: '',
        idx: '',
        stk_itg_tp: '1',
        dmst_stex_tp: 'KRX',
        qry_tp: '2'
      }
    });
  }

  /**
   * 6. 주식 호가 요청 (ka10004)
   */
  async getStockQuote(stockCode) {
    return this._callApi({
      endpoint: '/api/dostk/mrkcond',
      apiId: KiwoomClient.TR_IDS.STOCK_QUOTE,
      params: { stk_cd: stockCode }
    });
  }

  /**
   * 7. 주식 분봉 차트 조회 (ka10080)
   * @param {string} stockCode - 종목코드
   * @param {string} ticScope - 분 단위 (1, 3, 5, 10, 15, 30, 45, 60)
   */
  async getMinuteChart(stockCode, ticScope = '10') {
    return this._callApi({
      endpoint: '/api/dostk/chart',
      apiId: KiwoomClient.TR_IDS.MINUTE_CHART,
      params: {
        stk_cd: stockCode,
        tic_scope: ticScope,
        upd_stkpc_tp: '1'
      }
    });
  }

  /**
   * 8. 주식 매수 주문 (kt10000)
   */
  async buyStock({ stockCode, quantity, price = '', tradeType = '3', exchange = 'KRX' }) {
    return this._callApi({
      endpoint: '/api/dostk/ordr',
      apiId: KiwoomClient.TR_IDS.BUY_ORDER,
      params: {
        dmst_stex_tp: exchange,
        stk_cd: stockCode,
        ord_qty: quantity.toString(),
        ord_uv: price.toString(),
        trde_tp: tradeType
      }
    });
  }

  /**
   * 9. 주식 매도 주문 (kt10001)
   */
  async sellStock({ stockCode, quantity, price = '', tradeType = '3', exchange = 'KRX' }) {
    return this._callApi({
      endpoint: '/api/dostk/ordr',
      apiId: KiwoomClient.TR_IDS.SELL_ORDER,
      params: {
        dmst_stex_tp: exchange,
        stk_cd: stockCode,
        ord_qty: quantity.toString(),
        ord_uv: price.toString(),
        trde_tp: tradeType
      }
    });
  }
}

// === 단독 실행 예제 ===
// === 단독 실행 및 CLI 대응 ===
async function main() {
  const APP_KEY = process.env.KIWOOM_APP_KEY;
  const APP_SECRET = process.env.KIWOOM_APP_SECRET;
  const IS_MOCK = process.env.KIWOOM_IS_MOCK !== 'false'; // 기본값 true (모의투자)

  if (!APP_KEY || !APP_SECRET) {
    console.error('[Error] KIWOOM_APP_KEY와 KIWOOM_APP_SECRET 환경변수가 필요합니다.');
    console.log('\n사용법:');
    console.log('  KIWOOM_APP_KEY=.. KIWOOM_APP_SECRET=.. node kiwoom_api.js [command] [args]');
    console.log('\n명령어 예시:');
    console.log('  node kiwoom_api.js accounts          # 계좌 목록 조회');
    console.log('  node kiwoom_api.js balance [계좌번]  # 계좌 잔고 조회');
    console.log('  node kiwoom_api.js quote [종목코드]  # 주식 호가 조회 (예: 005930)');
    console.log('  node kiwoom_api.js buy [코드] [수량] [가격] # 주식 매수 주문');
    return;
  }

  const client = new KiwoomClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    isMock: IS_MOCK
  });

  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  try {
    // 1. 인증 (인증이 필요한 모든 명령에 대해 공통 실행)
    const authResult = await client.issueToken();
    if (!authResult.success) {
      console.error('인증 실패:', authResult.error);
      return;
    }

    switch (command) {
      case 'accounts': {
        const res = await client.getAccounts();
        console.log('계좌 목록:', JSON.stringify(res.body, null, 2));
        break;
      }

      case 'balance': {
        const accNo = args[1];
        if (!accNo) {
          console.log('사용법: node kiwoom_api.js balance [계좌번호]');
          return;
        }
        const res = await client.getAccountBalance(accNo);
        console.log(`계좌(${accNo}) 잔고 정보:`, JSON.stringify(res.body, null, 2));
        break;
      }

      case 'quote': {
        const code = args[1] || '005930'; // 기본 삼성전자
        const res = await client.getStockQuote(code);
        console.log(`${code} 호가 정보:`, JSON.stringify(res.body, null, 2));
        break;
      }

      case 'buy': {
        const [_, code, qty, price] = args;
        if (!code || !qty) {
          console.log('사용법: node kiwoom_api.js buy [종목코드] [수량] [가격(선택)]');
          return;
        }
        const res = await client.buyStock({
          stockCode: code,
          quantity: parseInt(qty),
          price: price || '',
          tradeType: price ? '00' : '03' // 가격 있으면 지정가(00), 없으면 시장가(03)
        });
        console.log('매수 주문 결과:', JSON.stringify(res.body, null, 2));
        break;
      }

      case 'minute': {
        const [_, code, scope] = args;
        if (!code) {
          console.log('사용법: node kiwoom_api.js minute [종목코드] [분(기본:10)]');
          return;
        }
        const res = await client.getMinuteChart(code, scope || '10');
        console.log(`${code} (${scope || '10'}분봉) 차트 데이터:`, JSON.stringify(res.body, null, 2));
        break;
      }

      case 'sell': {
        const [_, code, qty, price] = args;
        if (!code || !qty) {
          console.log('사용법: node kiwoom_api.js sell [종목코드] [수량] [가격(선택)]');
          return;
        }
        const res = await client.sellStock({
          stockCode: code,
          quantity: parseInt(qty),
          price: price || '',
          tradeType: price ? '00' : '03' // 가격 있으면 지정가(00), 없으면 시장가(03)
        });
        console.log('매도 주문 결과:', JSON.stringify(res.body, null, 2));
        break;
      }

      case 'help':
      default: {
        console.log('\n지원되는 명령어:');
        console.log('  accounts                     : 계좌 목록 조회');
        console.log('  balance [계좌번호]            : 계좌 잔고/예수금 조회');
        console.log('  quote [종목코드]              : 주식 호가 조회');
        console.log('  minute [종목코드] [분]        : 분봉 차트 데이터 조회 (틱 단위: 1, 3, 5, 10, ... 등)');
        console.log('  buy [코드] [수량] [가격]      : 주식 매수 주문 (가격 생략 시 시장가)');
        console.log('  sell [코드] [수량] [가격]     : 주식 매도 주문 (가격 생략 시 시장가)');
        break;
      }
    }
  } catch (error) {
    console.error('실행 중 오류 발생:', error);
  }
}

// 직접 실행될 때만 main 호출
if (require.main === module) {
  console.log('Kiwoom REST API Service (Standalone Node.js)');
  main();
}

module.exports = KiwoomClient;
