# 외부 구성 요소 고지

이 프로젝트는 [itldg/web-serial-debug](https://github.com/itldg/web-serial-debug)의 한국어 포크입니다. 원본 프로젝트의 Apache-2.0 [LICENSE](LICENSE)는 변경하지 않았으며, 변경 사실은 [NOTICE](NOTICE)에 표시합니다.

웹 페이지에서 사용하는 외부 라이브러리는 CDN에 접속하지 않고 같은 사이트의 파일로 제공합니다. 패키지 버전과 무결성 정보는 `package-lock.json`에, 벤더 파일별 SHA-256은 `vendor/manifest.json`에 기록됩니다.

| 구성 요소 | 버전 | 용도 | 라이선스 원문 |
| --- | --- | --- | --- |
| [Bootstrap](https://github.com/twbs/bootstrap) | 5.3.8 | UI와 모달 | [MIT](vendor/bootstrap/LICENSE) |
| [Popper](https://github.com/floating-ui/floating-ui/tree/v2.x) | 2.11.8 | Bootstrap 번들에 포함 | [MIT](vendor/popper/LICENSE.md) |
| [Bootstrap Icons](https://github.com/twbs/icons) | 1.13.1 | 로컬 아이콘 폰트 | [MIT](vendor/bootstrap-icons/LICENSE) |
| [CodeMirror](https://github.com/codemirror/codemirror5) | 5.65.21 | JavaScript 스크립트 편집기 | [MIT](vendor/codemirror/LICENSE) |
| [ansi_up](https://github.com/drudru/ansi_up) | 5.1.0 | ANSI 로그 색상 표시 | [MIT](vendor/ansi_up/LICENSE) |

`npm run vendor`는 설치된 npm 패키지에서 필요한 파일과 라이선스만 복사합니다. 배포하지 않는 소스맵의 참조 주석만 제거하며 라이선스 주석은 유지합니다. CodeMirror의 `*.min.js`/`*.min.css` 파일명은 기존 경로 규칙을 위한 것이며, 내용은 패키지의 원본 JavaScript/CSS입니다. 원본 프로젝트에 포함된 `js/ansi_up.min.js`는 그대로 유지하고 해당 버전의 라이선스만 추가합니다.

`vendor/`와 `dist/`는 생성물입니다. 해당 폴더를 직접 수정하지 말고 패키지 버전 또는 `scripts/vendor.cjs`를 수정한 뒤 다시 빌드하세요.
