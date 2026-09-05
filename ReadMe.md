# Web Serial Debug

Browser-based serial monitor with **한국어 / English / 简体中文** UI. A fork of [itldg/web-serial-debug](https://github.com/itldg/web-serial-debug), with validated settings, bounded logs, quick commands and explicit FUNSR PRO configuration.

**[웹에서 열기](https://sioaeko.github.io/Web-Serial-Debug/)** · [소스 코드](https://github.com/sioaeko/Web-Serial-Debug)

## Language / 언어 / 语言

Use the language selector in the header. **Auto** follows the first supported browser language (English fallback). Your selection is saved in this browser and changes the UI immediately without reconnecting or sending anything. Device traffic, saved command names/content and script source are never translated. Language selection is separate from settings backups.

상단 언어 선택에서 한국어·영어·중국어(간체)를 고를 수 있습니다. **자동**은 브라우저의 지원 언어를 따르며, 지원 언어가 없으면 영어를 사용합니다. 선택은 브라우저에 저장됩니다. 언어를 바꿔도 연결, 입력 중인 명령, 설정 초안, 전송 기록과 스크립트는 유지되며 전송을 시작하지 않습니다.

使用顶部的语言选择器切换韩语、英语或简体中文。**自动**跟随浏览器支持的语言，无匹配时使用英语。语言选择会保存在浏览器中。切换语言不会重新连接、发送命令或更改设备数据、已保存命令和脚本。

## Quick start

Open the site in desktop Chrome or Edge, connect a USB serial device, choose **Select port**, set the baud rate and other parameters required by your device, then connect. HTTPS or localhost is required. Sending text uses UTF-8 plus the selected line ending; HEX sends raw bytes. Presets do not detect device settings.

FUNSR controls are specifically for **FUNSR PRO Kp configuration**, not live motor speed, RPM or a percentage. Adjust only while the device is stationary. Confirm the device yourself before sending one DKP command. Physical-device compatibility and operation have not been verified; other models are not assumed compatible.

## 시작하기

1. 데스크톱 Chrome 또는 Edge에서 위 사이트를 엽니다. 별도 앱 설치는 필요 없습니다.
2. USB 시리얼 장치를 연결하고 **포트 선택**에서 장치를 고릅니다.
3. 장치 설명서에 맞는 통신 속도·데이터 비트·패리티·종료 문자를 설정한 뒤 연결합니다. 프리셋은 시작점일 뿐 장치 설정을 자동 감지하지 않습니다.
4. 수신 로그를 확인하거나 TEXT/HEX 모드에서 명령을 보냅니다.

Web Serial을 지원하는 브라우저와 **HTTPS 또는 localhost/127.0.0.1** 환경이 필요합니다. Firefox, Safari 및 모바일 브라우저는 이 프로젝트의 지원 대상이 아닙니다. USB-시리얼 드라이버가 필요한 장치는 운영체제에 드라이버가 설치되어 있어야 합니다. 다른 프로그램이 포트를 사용 중이면 먼저 해당 프로그램의 연결을 해제하세요.

## 주요 기능

- 한국어·영어·중국어(간체) 설정, 안내, 오류 메시지와 스크립트 도움말
- Arduino, ESP32 AT, Modbus RTU 통신 설정 프리셋
- FUNSR PRO DKP 설정값 선택·단발 전송과 기기 응답 구분 표시
- 수신 텍스트 UTF-8 / EUC-KR / Windows-1252 인코딩 선택
- TEXT·HEX·ANSI 로그, 검색·필터, 표시 일시정지, 타임스탬프, 줄바꿈 및 로그 보관량 설정
- 송수신 바이트 수와 최근 전송 기록, 자주 쓰는 명령의 그룹 관리
- 설정 및 명령 모음 JSON 가져오기·내보내기
- 밝은/어두운 테마와 키보드 단축키
- 외부 CDN·분석 스크립트 없이 같은 사이트에서 모든 실행 자산 제공

| 프리셋 | 시리얼 설정 | TEXT 종료 문자 |
| --- | --- | --- |
| Arduino | 9600 bps · 8N1 | LF |
| ESP32 AT | 115200 bps · 8N1 | CRLF |
| Modbus RTU | 9600 bps · 8E1 | 없음 |

Modbus 프리셋은 통신 파라미터만 설정합니다. Modbus 프레임 구성이나 CRC 계산을 자동으로 수행하는 기능은 아닙니다.

수신 인코딩은 변경 이후 도착하는 데이터부터 적용되며, 바꾸어도 **TEXT 송신은 UTF-8**입니다. 다른 인코딩의 바이트를 전송해야 한다면 미리 변환한 값을 HEX 모드에 입력하세요. 종료 문자 없음/LF/CR/CRLF도 장치의 프로토콜에 맞춰 선택해야 합니다. 선택한 종료 문자는 TEXT 송신에만 붙고, HEX 송신은 입력한 원시 바이트만 보냅니다.

## FUNSR PRO 속도 설정 (DKP)

[제공된 FUNSR PRO 속도 조정 안내](https://docs.google.com/document/d/1Lkpiut9cdt8qYc-muuYnayMDVhw4WhIA3nHZwXqnCo4/edit?tab=t.0)에 따른 **Kp 설정**입니다. 범위는 **0.5~5.0**, 기본값은 **1.2**이며 UI에서는 **0.1 단위**로 선택합니다. 값이 클수록 최대 속도와 소음이 커집니다. 실시간 운전 속도나 mm/s·RPM·퍼센트를 나타내는 값은 아닙니다.

1. 기기가 움직이지 않는 상태에서 설정하세요. FUNSR PRO의 시리얼 연결을 열고 오른쪽 **속도** 탭을 선택합니다. 실행 중인 반복 전송과 사용자 스크립트는 먼저 중지하세요.
2. 슬라이더, 숫자 입력, ±0.1 버튼 또는 최소·기본·최대 버튼으로 **보낼 값**을 정합니다. 모두 초안만 바꾸며 전송하지 않습니다. 초기 표시 1.2도 현재 기기에서 읽어 온 값은 아닙니다.
3. **FUNSR PRO에 연결했음을 확인했습니다**를 체크하고 **설정 전송**을 직접 누릅니다. 체크는 사용자의 확인이지 장치 자동 식별이 아닙니다. 연결이 바뀌거나 재연결되면 다시 확인해야 합니다.

예를 들어 4.6을 선택하면 일반 전송창의 HEX·줄바꿈 옵션과 무관하게 ASCII 명령 `DKP4.6`에 고정 **CRLF**를 붙여 **한 번만** 보냅니다(`DKP4.6\r\n`). 연결, 입력 변경, 확인 체크, 새로고침, 설정 가져오기만으로는 전송하지 않습니다. 이 초안은 설정 백업·복원 대상에 포함되지 않습니다.

| 확인 단계 | 의미 |
| --- | --- |
| 호스트 전송 완료 | 브라우저의 쓰기가 완료된 상태입니다. 기기의 저장 성공을 뜻하지 않습니다. |
| 기기 저장 응답 확인 | 현재 요청값과 일치하는 `new kp is 4.60!`에 이어 `kp saved, please reboot!`를 수신한 상태입니다. 기기를 직접 재시작해야 합니다. |
| 기기 보고값 확인 | 사용자가 직접 재시작한 뒤 `Motor global kp is 4.60` 같은 부팅 출력을 수신하면 별도로 표시합니다. 입력 초안이나 실측 속도가 아닙니다. |

저장 응답이 없으면 전송 완료와 저장 미확인을 구분해 표시하며 자동으로 재시도하지 않습니다. 앱은 재부팅이나 설정 조회 명령을 보내지 않습니다. 실제 FUNSR PRO에서 전송·저장·재시작 동작을 검증한 것은 아니며, 다른 모델의 호환성도 확인하지 않았습니다.

## 편하게 사용하기

| 단축키 | 동작 |
| --- | --- |
| Ctrl + Enter | 전송 입력창에서 명령 전송 |
| Ctrl + L | 확인 후 로그·송수신 카운터 비우기 |
| Ctrl + K | 로그 검색창으로 이동 |
| Alt + ↑ / ↓ | 전송 입력창에서 이전/다음 전송 기록 |

macOS에서는 Ctrl 대신 ⌘ Command로도 사용할 수 있습니다. 한글 조합 중에는 전송 단축키가 동작하지 않습니다.

전송 기록은 최근 30개를 유지합니다. 로그 표시를 일시정지해도 장치의 수신 자체가 멈추지는 않습니다. 로그 보관량 제한에 도달하면 오래된 항목부터 제거되므로 장시간 기록이 필요할 때는 중간에 로그를 저장하세요. 복사·저장은 현재 검색·방향 필터에 맞는 보관 로그를 대상으로 하므로, 화면을 일시정지한 동안 들어온 로그도 포함될 수 있습니다.

설정 백업과 명령 모음은 JSON 파일로 이동할 수 있습니다. 설정 백업을 가져오기 전에는 시리얼 연결을 종료하세요. 가져오기는 값을 불러오는 작업이며 연결, 반복 전송 또는 스크립트 실행을 자동으로 시작하지 않습니다. 기존 설정을 바꾸기 전에는 현재 설정을 먼저 내보내 두는 것을 권장합니다.

## 사용자 스크립트

JavaScript로 수신 데이터를 해석하거나 명령을 생성할 수 있습니다. 아래 예제는 수신 길이만 로그에 표시하며 자동으로 데이터를 보내지 않습니다.

```javascript
addEventListener('message', ({ data }) => {
  if (data.type === 'uart_receive') {
    postMessage({ type: 'log', data: '수신: ' + data.data.length + '바이트' });
  }
});
```

| 메시지 종류 | 데이터 | 방향·의미 |
| --- | --- | --- |
| `uart_receive` | 바이트 배열 | 앱 → 스크립트: 수신 데이터 |
| `uart_send` | 바이트 배열 | 스크립트 → 앱: 바이트 송신 |
| `uart_send_txt` | 문자열 | 스크립트 → 앱: UTF-8 텍스트 송신 |
| `uart_send_hex` | 16진수 문자열 | 스크립트 → 앱: HEX 송신 |
| `log` | 문자열 | 스크립트 → 앱: 로그 출력 |

**직접 확인하고 신뢰하는 코드만 실행하세요.** Worker는 UI 스레드와 실행을 분리할 뿐 네트워크 접근을 막는 보안 샌드박스가 아닙니다. 실행한 코드는 장치로 명령을 보내거나 네트워크 요청을 시도할 수 있습니다. 출처를 모르는 설정 파일에 포함된 스크립트를 실행하지 마세요.

## 개인정보와 저장 위치

기본 앱은 시리얼 데이터·명령·설정을 외부 서버로 전송하지 않으며 광고·방문 분석 코드를 포함하지 않습니다. 설정과 명령 모음 등은 사용 중인 브라우저의 로컬 저장소에 저장됩니다. 다른 브라우저나 기기로 자동 동기화되지 않고, 사이트 데이터를 지우면 로컬 설정도 지워질 수 있습니다.

사이트를 불러올 때는 GitHub Pages에 정적 파일을 요청하므로 호스팅 사업자의 일반적인 접속 기록은 별개입니다. 사용자가 직접 실행하는 스크립트는 위의 네트워크 제한을 보장하지 않습니다. 내보낸 설정·명령·로그에는 장치 정보나 민감한 내용이 들어갈 수 있으니 공유 전에 확인하세요.

## 개발·검증

개발할 때만 Node.js 22.13 이상인 22.x 또는 24 이상과 npm이 필요합니다. CI는 최신 22.x를 사용합니다.

```sh
npm ci --ignore-scripts
npm run vendor
npm test
npm run build
npm run dev
```

개발 주소는 [http://127.0.0.1:4173/Web-Serial-Debug/](http://127.0.0.1:4173/Web-Serial-Debug/)입니다. `npm run preview`는 빌드한 `dist/`를 같은 주소로 제공합니다. 포트 변경은 `npm run dev -- --port 4174`처럼 지정합니다. 개발 서버는 읽기 전용이며 공개 파일만 제공합니다.

- `npm run vendor`: 버전이 고정된 로컬 npm 패키지에서 실행 자산과 라이선스를 복사합니다.
- `npm run check`: JavaScript 문법, 중복 ID, 한국어 문서 선언, 로컬 자산 경로 및 알려진 추적 코드 잔존 여부를 검사합니다.
- `npm test`: Node.js 자동 테스트를 실행합니다.
- `npm run build`: `vendor/`를 다시 생성하고 검증한 공개 파일만 새 `dist/`에 복사합니다. `npm ci` 이후 빌드에 CDN이나 추가 네트워크 다운로드가 필요하지 않습니다.

`vendor/`와 `dist/`는 다시 생성될 수 있으므로 직접 수정하지 마세요. 빌드는 저장소 루트 주소와 GitHub Pages의 하위 경로에서 모두 해석되는 상대 자산 경로를 검증합니다. 메모리 시리얼 포트를 사용하는 자동 테스트는 실제 USB 장치, 드라이버 및 케이블을 연결한 실기기 검증을 대체하지 않습니다.

## GitHub Pages 배포

저장소의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정합니다. `main`에 변경 사항을 push하면 테스트와 빌드가 성공한 경우에만 `dist/`가 배포됩니다. Actions에서 수동 실행할 수도 있으며, `main` 이외의 브랜치와 Pull Request는 배포하지 않습니다.

워크플로는 [.github/workflows/pages.yml](.github/workflows/pages.yml)에 있습니다. 저장소 쓰기 권한이나 개인 토큰 없이 GitHub의 Pages 배포 권한으로 동작합니다. 다른 계정·저장소 이름으로 Fork했다면 위 사용 주소도 해당 Pages 주소로 변경하세요.

## 원작과 라이선스

원작: **itldg 및 Web Serial Debug 기여자** — [원본 저장소](https://github.com/itldg/web-serial-debug)

이 저장소는 원작을 기반으로 하는 독립적인 한국어 커뮤니티 포크이며 원작의 공식 한국어 릴리스를 뜻하지 않습니다. 원본의 [Apache License 2.0](LICENSE)을 유지합니다. 한국어화와 기능·배포 관련 변경 사실은 [NOTICE](NOTICE)에, 포함된 외부 구성 요소의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 안내합니다.
