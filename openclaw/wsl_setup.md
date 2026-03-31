# OpenClaw WSL & Systemd 설치 및 관리 가이드

이 문서는 OpenClaw를 WSL2(Ubuntu) 환경에서 백그라운드 서비스(Systemd)로 동작시키고, Windows 부팅 시 자동 실행되도록 설정하는 전체 과정을 담고 있습니다.

## 1단계: WSL 및 필수 도구 설치 (Windows/WSL 공통)

1. **WSL2 활성화 및 Ubuntu 설치** (Windows 터미널, 관리자 권한):
   ```powershell
   wsl --install -d Ubuntu
   ```
   *설치 후 반드시 컴퓨터를 재부팅해야 합니다.*

2. **Ubuntu 내 필수 도구 설치**:
   Ubuntu 터미널을 열고 다음 명령어를 실행합니다.
   ```bash
   # Node.js 22 설치
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # OpenClaw 설치
   sudo npm install -g openclaw@latest
   ```

## 2단계: Systemd 활성화 (WSL)

WSL에서 서비스 자동 실행을 위해 systemd를 활성화합니다.
```bash
sudo bash -c 'cat <<EOF > /etc/wsl.conf
[boot]
systemd=true
EOF'
```
*설정 적용을 위해 Windows 터미널에서 `wsl --shutdown` 명령으로 WSL을 껐다 켜야 합니다.*

## 3단계: 서비스 등록 및 자동 실행 (`gateway run`)

OpenClaw를 백그라운드 서비스로 등록합니다. **중요: 중복 실행 방지를 위해 사용자용 서비스는 비활성화해야 합니다.**

1. **중복 서비스 비활성화**:
   ```bash
   systemctl --user stop openclaw-gateway.service 2>/dev/null
   systemctl --user disable openclaw-gateway.service 2>/dev/null
   ```

2. **시스템 서비스 등록** (`/etc/systemd/system/openclaw.service`):
   ```bash
   sudo bash -c "cat <<EOF > /etc/systemd/system/openclaw.service
   [Unit]
   Description=OpenClaw AI Agent Gateway
   After=network.target

   [Service]
   Type=simple
   ExecStart=/usr/bin/openclaw gateway run
   Restart=always
   User=$(whoami)
   Environment=PATH=/usr/bin:/usr/local/bin
   WorkingDirectory=/home/$(whoami)

   [Install]
   WantedBy=multi-user.target
   EOF"

   # 서비스 활성화
   sudo systemctl daemon-reload
   sudo systemctl enable openclaw
   sudo systemctl start openclaw
   ```

## 4단계: Windows 부팅 시 자동 실행 (작업 스케줄러)

Windows 부팅 및 로그인 시 자동으로 WSL 환경을 깨우고 OpenClaw 서비스를 올리도록 등록합니다.

```powershell
# WSL2는 활성화된 터미널 창(포그라운드 프로세스)이 없으면 약 60초 후 자동으로 완전 종료됩니다.
# 시스템(Systemd) 서비스는 이 타이머를 막지 못하므로, VBScript를 이용해 백그라운드에서
# 보이지 않는 wsl.exe 프로세스(sleep infinity)를 영구적으로 띄워 자동 종료를 방지합니다.

$vbsPath = "$env:USERPROFILE\wsl_openclaw_autostart.vbs"
Set-Content -Path $vbsPath -Value 'CreateObject("Wscript.Shell").Run "wsl.exe -d Ubuntu -e bash -c ""sleep infinity""", 0, False'

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "OpenClaw_AutoStart" -Description "OpenClaw Background Start" -RunLevel Highest -Settings $settings
```

---

## 서비스 관리 명령어 리스트

- **상태 확인**: `sudo systemctl status openclaw`
- **실시간 로그**: `sudo journalctl -u openclaw -f`
- **서비스 재시작**: `sudo systemctl restart openclaw`
- **서비스 중지**: `sudo systemctl stop openclaw`
