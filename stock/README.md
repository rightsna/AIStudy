# Kiwoom REST API Standalone (Node.js)

이 폴더는 키움증권 REST API 연동을 위한 독립적인 Node.js 코드를 포함하고 있습니다.

## 파일 구성
- `kiwoom_api.js`: 키움 API 연동을 위한 클라이언트 클래스 및 실행 예제 코드
- `.env.example`: 환경변수 설정 예시

## 실행 방법

1. **사전 준비**:
   - Node.js (v18 이상 권장)가 설치되어 있어야 합니다.
   - 외부 라이브러리(axios 등)를 사용하지 않고 내장 `fetch` API를 사용하도록 설계되었습니다.

2. **환경 설정**:
   - `.env.example` 파일을 복사하여 `.env` 파일을 만듭니다.
   - 키움증권에서 발급받은 `APP_KEY`와 `APP_SECRET`을 설정합니다.

#### 명령어별 실행 예시

인증 정보가 담긴 환경변수와 함께 아래 명령어들을 조합하여 실행할 수 있습니다.

```bash
# 1. 계좌 목록 조회
node --env-file=.env kiwoom_api.js accounts

# 2. 특정 계좌 잔고 및 예수금 조회
node --env-file=.env kiwoom_api.js balance 8150000000

# 3. 특정 종목(예: 삼성전자) 실시간 호가 조회
node --env-file=.env kiwoom_api.js quote 005930

# 4. 특정 종목 분봉 차트 조회 (예: 삼성전자 10분봉 20개 등)
node --env-file=.env kiwoom_api.js minute 005930 10

# 5. 주식 매수 주문 (시장가)
# 예: 삼성전자(005930)를 시장가로 10주 매수
node --env-file=.env kiwoom_api.js buy 005930 10

# 6. 주식 매수 주문 (지정가)
# 예: 삼성전자(005930)를 70,000원에 5주 매수
node --env-file=.env kiwoom_api.js buy 005930 5 70000

# 7. 주식 매도 주문 (시장가)
# 예: 삼성전자(005930)를 시장가로 1주 매도
node --env-file=.env kiwoom_api.js sell 005930 1
```

> [!TIP]
> 실전투자 서버를 사용하려면 환경변수에 `KIWOOM_IS_MOCK=false`를 추가하거나 `.env` 파일을 수정하세요.

## 주요 기능
- `issueToken()`: 접근 토큰 발급
- `getAccounts()`: 계좌 목록 조회
- `getAccountEvaluation(accountNo)`: 계좌 평가 현황
- `getDepositDetails(accountNo)`: 예수금 상세 조회
- `getAccountBalance(accountNo)`: 종목별 잔고 조회
- `getStockQuote(stockCode)`: 주식 호가 조회
- `buyStock({ ... })`: 주식 매수 주문
- `sellStock({ ... })`: 주식 매도 주문

## 자동매매 전략 (Auto Trader)

`strategy.js`는 삼성전자(005930)를 대상으로 한 RSI 기반의 자동매매 봇입니다.

### 📈 주요 전략 (RSI 14)
- **타임프레임**: 10분봉
- **진입 규칙**: RSI(14) <= 28 이고, 현재 종가가 이전 종가보다 높을 때 (반등 확인)
- **매수 비중**: 예수금의 10% (1회 진입)
- **청산 규칙**:
  - **익절**: 진입가 대비 +0.4%
  - **손절**: 진입가 대비 -0.3%
  - **타임컷**: 진입 후 60분 경과 시 강제 시장가 정리
- **안전장치 (Risk Management)**:
  - 당일 누적 손실 -1.0% 도달 시 그날 매매 중단
  - 당일 연속 3회 손절 시 전략 부적합으로 판단하여 매매 중단

### 🚀 실행 방법
```bash
# 모의투자 서버에서 자동매매 시작
node --env-file=.env strategy.js
```
*실행 시 `position.json` 파일에 거래 상태와 일일 수익률 통계가 기록됩니다.*
