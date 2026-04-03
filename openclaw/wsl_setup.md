---
description: OpenClaw WSL & Systemd 자동 설치 및 관리 워크플로
---

// turbo-all

# OpenClaw WSL & Systemd 설치 및 관리 가이드 (자동화 버전)

이 문서는 OpenClaw를 WSL2(Ubuntu) 환경에서 백그라운드 서비스(Systemd)로 동작시키고, Windows 부팅 시 자동 실행되도록 설정하는 전체 과정을 담고 있습니다. (Antigravity AI에 의해 최적화된 설정이 포함되어 있습니다.)

---

## 1단계: WSL 및 Ubuntu 무인 설치 (Windows Terminal/PowerShell)

**PowerShell**을 **관리자 권한**으로 실행한 뒤, 다음 명령어를 한 줄씩(또는 전체 복사) 실행하세요. 이 과정은 사용자 이름이나 비밀번호를 직접 입력할 필요가 없습니다.

1. **Ubuntu 설치 (비대화형)**:
   ```powershell
   # Ubuntu 배포판 설치 (화면이 뜨면 일단 닫아도 됩니다)
   wsl --install -d Ubuntu --no-launch
   ```

2. **claw 계정 자동 생성 및 설정 (비밀번호: claw)**:
   설치가 완료된 후 아래 명령어를 실행하여 `claw` 계정을 생성하고 권한을 부여합니다.
   ```powershell
   # claw 사용자 생성, 비밀번호 설정(claw), sudo 권한 부여를 한 번에 수행
   wsl -d Ubuntu -u root bash -c "useradd -m -s /bin/bash claw && echo 'claw:claw' | chpasswd && usermod -aG sudo claw"

   # WSL 접속 시 기본 사용자를 claw로 고정
   wsl -d Ubuntu -u root bash -c "printf '[user]\ndefault=claw\n' >> /etc/wsl.conf"
   ```

3. **Ubuntu 내 필수 도구 설치**:
   이제 `claw` 계정이 준비되었습니다. 아래 명령어로 필요한 도구들을 설치합니다.
   ```powershell
   # Node.js 22 설치
   wsl -d Ubuntu -u root bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"

   # OpenClaw 전역 설치
   wsl -d Ubuntu -u root npm install -g openclaw@latest
   ```

---

## 2단계: Systemd 활성화 (WSL)

WSL에서 서비스 자동 실행을 위해 systemd를 활성화합니다.
```bash
sudo bash -c 'cat <<EOF > /etc/wsl.conf
[boot]
systemd=true
EOF'
```
*설정 적용을 위해 Windows 터미널에서 `wsl --shutdown` 명령으로 WSL을 껐다 켜야 합니다.*

---

## 3단계: 서비스 등록 및 자동 실행 (`gateway run`)

OpenClaw를 백그라운드 서비스로 등록합니다. **중요: 초기 설정이 없는 경우에도 실행되도록 `--allow-unconfigured` 옵션이 추가되었습니다.**

1. **중복 서비스 비활성화 (필수)**:
   기존에 사용자 모드로 설치된 게이트웨이가 있다면 반드시 아래 명령어로 원천 차단해야 합니다. (중복 실행 시 포트 충돌로 인해 게이트웨이가 작동하지 않습니다.)
   ```bash
   # 사용자 서비스 중지 및 비활성화
   wsl -d Ubuntu -- systemctl --user stop openclaw-gateway.service 2>/dev/null || true
   wsl -d Ubuntu -- systemctl --user disable openclaw-gateway.service 2>/dev/null || true

   # 인증 우회를 위한 사전 설정 파일 주입 (Token Mismatch 방지)
   wsl -u claw -d Ubuntu -- bash -c "mkdir -p ~/.openclaw && echo '{ \"gateway\": { \"mode\": \"local\", \"port\": 18789, \"auth\": { \"mode\": \"none\" } } }' > ~/.openclaw/openclaw.json"
   ```

2. **시스템 서비스 등록** (`/etc/systemd/system/openclaw.service`):
   ```bash
   sudo bash -c "cat <<EOF > /etc/systemd/system/openclaw.service
   [Unit]
   Description=OpenClaw AI Agent Gateway
   After=network.target

   [Service]
   Type=simple
   # --allow-unconfigured 옵션을 통해 설정 부재 시에도 게이트웨이 구동 가능
   ExecStart=/usr/bin/openclaw gateway run --allow-unconfigured
   Restart=always
   User=claw
   Environment=PATH=/usr/bin:/usr/local/bin
   WorkingDirectory=/home/claw

   [Install]
   WantedBy=multi-user.target
   EOF"

   # 서비스 활성화
   sudo systemctl daemon-reload
   sudo systemctl enable openclaw
   sudo systemctl start openclaw
   ```

---

## 4단계: Windows 부팅 시 자동 실행 (작업 스케줄러)

Windows 부팅 및 로그인 시 자동으로 WSL 환경을 깨우고 OpenClaw 서비스를 올리도록 등록합니다. **(이 작업은 AI가 권한을 받아 직접 수행할 수 있습니다.)**

1. **WSL 종료 방지용 VBScript 생성**:
   // turbo
   ```powershell
   $vbsPath = "$env:USERPROFILE\wsl_openclaw_autostart.vbs"
   Set-Content -Path $vbsPath -Value 'CreateObject("Wscript.Shell").Run "wsl.exe -d Ubuntu -e bash -c ""sleep infinity""", 0, False'
   ```

2. **작업 스케줄러 등록 (관리자 권한 필수)**:
   // turbo
   ```powershell
   $vbsPath = "$env:USERPROFILE\wsl_openclaw_autostart.vbs"
   $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`""
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
   Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "OpenClaw_AutoStart" -Description "OpenClaw Background Start" -RunLevel Highest -Settings $settings -Force
   ```

---

## 5단계: 설치 검증 (전체 점검)

모든 설치가 정상적으로 완료되었는지 아래 항목들을 하나씩 확인합니다. 모두 통과해야 정상입니다.

1. **systemd 동작 확인** (PID 1이 `systemd`여야 함):
   ```powershell
   wsl -d Ubuntu -- bash -c "ps -p 1 -o comm="
   ```
   - ✅ 정상: `systemd`
   - ❌ 비정상: `init` 또는 다른 값 → 2단계 재수행 후 `wsl --shutdown` 필요

2. **openclaw 설치 확인**:
   ```powershell
   wsl -d Ubuntu -- bash -c "which openclaw && openclaw --version"
   ```
   - ✅ 정상: 경로(`/usr/bin/openclaw`)와 버전이 출력됨
   - ❌ 비정상: `command not found` → 1단계의 npm install 재수행

3. **게이트웨이 서비스 상태 확인**:
   ```powershell
   wsl -d Ubuntu -- bash -c "systemctl status openclaw"
   ```
   - ✅ 정상: `Active: active (running)` 및 `enabled`
   - ❌ 비정상: `could not be found` → 3단계 재수행, `inactive/failed` → 로그 확인 후 재시작

4. **게이트웨이 포트 리스닝 확인** (18789 포트):
   ```powershell
   wsl -d Ubuntu -- bash -c "ss -tlnp | grep 18789"
   ```
   - ✅ 정상: `LISTEN` 상태의 18789 포트가 보임
   - ❌ 비정상: 출력 없음 → 서비스 로그 확인 (`journalctl -u openclaw --no-pager -n 30`)

5. **설정 파일 확인**:
   ```powershell
   wsl -d Ubuntu -- bash -c "cat ~/.openclaw/openclaw.json"
   ```
   - ✅ 정상: `"mode": "local"`, `"port": 18789`, `"auth": { "mode": "none" }` 포함
   - ❌ 비정상: 파일 없음 또는 내용 다름 → 3단계의 설정 파일 주입 재수행

6. **Windows 작업 스케줄러 확인**:
   ```powershell
   Get-ScheduledTask -TaskName 'OpenClaw_AutoStart' -ErrorAction SilentlyContinue | Format-List TaskName,State
   ```
   - ✅ 정상: `TaskName: OpenClaw_AutoStart`, `State: Ready`
   - ❌ 비정상: 출력 없음 → 4단계 재수행 (관리자 권한 필수)

7. **VBScript 파일 존재 확인**:
   ```powershell
   Test-Path "$env:USERPROFILE\wsl_openclaw_autostart.vbs"
   ```
   - ✅ 정상: `True`
   - ❌ 비정상: `False` → 4단계의 VBScript 생성 재수행

> 모든 항목이 ✅이면 설치가 정상 완료된 것입니다. 리부트 후에도 게이트웨이가 자동으로 실행됩니다.

---

## 6단계: 완료 및 Onboard 안내 (AI 수행)

**(AI는 이전 단계까지 모두 완료한 뒤, 반드시 사용자에게 다음 내용을 안내해 주세요.)**

"모든 설치와 백그라운드 서비스 등록이 완료되었습니다. 이제 직접 Windows 터미널이나 PowerShell을 열고 `ubuntu`를 입력하여 WSL에 접속한 뒤, 아래 명령어를 실행하여 초기 인증을 완료해 주세요."
`openclaw onboard`

---

## 서비스 관리 및 문제 해결

### 관리 명령어 리스트
- **상태 확인**: `wsl -d Ubuntu -- systemctl status openclaw`
- **로그 확인 (실시간)**: `wsl -d Ubuntu -- journalctl -u openclaw -f`
- **로그 확인 (전체)**: `wsl -d Ubuntu -- journalctl -u openclaw --no-pager`
- **서비스 재시작**: `wsl -d Ubuntu -- systemctl restart openclaw`
- **서비스 중지**: `wsl -d Ubuntu -- systemctl stop openclaw`
- **사용자 전환 (claw)**: `wsl -u claw`
- **사용자 전환 (root)**: `wsl -u root`

### 자주 발생하는 문제 (Troubleshooting)

1. **"Gateway token mismatch" 또는 접속 권한 관련 오류 발생 시**:
   설정 파일(`openclaw.json`)이 손상되었거나 토큰이 맞지 않을 때 발생합니다. 아래 명령어로 설정을 `local` 모드(인증 없음)로 초기화할 수 있습니다.
   ```bash
   # claw 계정 설정 초기화
   wsl -u claw -d Ubuntu -- bash -c "mkdir -p ~/.openclaw && echo '{ \"gateway\": { \"mode\": \"local\", \"port\": 18789, \"auth\": { \"mode\": \"none\" } } }' > ~/.openclaw/openclaw.json"

   # 이후 서비스 재시작
   wsl -u root -d Ubuntu -- systemctl restart openclaw
   ```

2. **UI는 뜨는데 "gateway run을 하라"는 메시지가 계속 나올 때**:
   포트 18789가 다른 프로그램(예: 사용자 모드 openclaw)에 의해 점유되어 있거나, 서비스가 비정상 종료된 상태입니다. `3단계`의 중복 서비스 비활성화를 다시 수행한 뒤 시스템 서비스를 재시작하세요.

---

*본 가이드는 AI 협업을 통해 검증 및 보완된 최신 버전입니다.*
