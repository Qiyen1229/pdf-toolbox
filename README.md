# PDF 工具箱

在瀏覽器端處理的全功能 PDF Web App：合併、分割、整理、裁切、壓縮、轉檔、註解、表單、加解密、真正塗黑、OCR、比較、批次處理、檢視器；含帳號、RBAC、管理後台、稽核日誌與 PWA（iOS 可「加入主畫面」）。

> **隱私設計**：所有 PDF 工具都在你的瀏覽器內完成，檔案不會上傳。後端只存帳號、設定、稽核日誌與「工具名稱 + 檔案大小區間」的用量統計。

- 架構與 ERD：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **已知限制（請先看）**：[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)
- 備份 / 還原 / 安全檢查：[docs/OPERATIONS.md](docs/OPERATIONS.md)

## 功能一覽
| 類別 | 工具 |
|---|---|
| 頁面編輯 | 合併、分割（範圍/每 N 頁/單頁）、整理（拖曳排序/旋轉/刪除/複製/空白頁）、裁切、頁面大小與方向、壓縮（多段品質、前後大小）、修復 |
| 轉換 | PDF↔圖片（JPG/PNG/WebP/TIFF）、文字/HTML/Markdown、PDF→Word/Excel/PPT（本機簡易版）、文字→PDF |
| 註解 | 螢光筆、底線、刪除線、波浪線、文字方塊、便利貼、形狀、手寫簽名、圖章、圖片；浮水印（文字/圖片、透明度、角度、平鋪）、頁首頁尾、頁碼、Bates、時間戳記 |
| 表單 | 建立（文字/多行/勾選/單選/下拉/日期）、填寫 AcroForm、扁平化 |
| 安全 | AES-256 加密與權限、解密、**真正塗黑**（含自動找 Email/電話/身分證…）、簽章檢視、中繼資料檢視/編輯/徹底移除 |
| 進階 | 文字擷取、多檔全文檢索、OCR（繁中/簡中/英/日 → 可搜尋 PDF）、書籤編輯、超連結管理、比較（視覺 + 文字）、文件資訊、批次處理 |
| 檢視器 | 縮放、連續/單頁、縮圖、全螢幕、夜間模式、朗讀、雙指捏合 |

## 本機啟動（開發 / 預覽）
需求：Node.js ≥ 22。**不需要安裝 PostgreSQL**（開發模式自動使用內嵌的 PGlite）。

```bash
npm install
npm run build                 # 產生 web/dist（含 PWA）；會自動複製 OCR 引擎與語言資料到 web/public/vendor
npm start                     # → http://localhost:9133
```
開發時可用 `npm run dev -w web`（Vite，連到 9133 的 API）。

初始化管理者（**需先停止伺服器**，因為內嵌資料庫同時只能被一個程序開啟）：
```bash
npm run admin:create -- --email admin@example.com
# 未設定 ADMIN_PASSWORD 時會印出一次性隨機密碼（可用環境變數 ADMIN_PASSWORD 指定）
```
開發環境的機密（JWT / 加密金鑰）會自動產生並存在 `server/data/dev-secrets.json`（已 gitignore）。

## 部署到 NAS（Docker）
```bash
cp .env.example .env          # 填入所有 CHANGE_ME；產生機密：openssl rand -base64 48
docker compose up -d --build  # 啟動 app（9133）+ PostgreSQL
docker compose exec app node dist/cli/create-admin.js --email admin@example.com
```
- 映像很小（無 LibreOffice / Ghostscript），因為所有處理都在瀏覽器完成。
- **HTTPS**：Service Worker、Safari「加入主畫面」與 Secure Cookie 需要 HTTPS。建議使用 NAS 內建反向代理（Synology：登入入口 → 進階 → 反向代理，目標 `localhost:9133`），或 `docker compose --profile https up -d`（Caddy 自動憑證，需網域與 80/443）。
- 僅在區網用 `http://` 測試時，請設 `COOKIE_SECURE=false`（不安全，勿用於正式環境）。
- 後台 IP 白名單：`ADMIN_IP_ALLOWLIST=192.168.1.0/24`。
- 備份與還原演練：見 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 環境變數
| 變數 | 說明 | 預設 |
|---|---|---|
| `PORT` | 服務埠 | `9133` |
| `DATABASE_URL` | PostgreSQL 連線字串；空白 = 內嵌 PGlite（僅開發/單機預覽） | — |
| `JWT_SECRET` | Access token 簽章金鑰（≥32 字元，**必填於生產**） | 開發自動產生 |
| `APP_ENC_KEY` | TOTP secret 等敏感欄位的 AES-256-GCM 金鑰來源（**必填於生產，請備份**） | 開發自動產生 |
| `PUBLIC_URL` | 對外網址（郵件連結） | `http://localhost:<PORT>` |
| `COOKIE_SECURE` | Cookie 加 `Secure` | 生產 `true` |
| `FORCE_HTTPS` | 應用層強制 https 與 HSTS | `false` |
| `TRUST_PROXY` | 反向代理層數 | 生產 `1` |
| `ADMIN_IP_ALLOWLIST` | 後台 IP/CIDR 白名單 | 不限制 |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | 郵件（驗證信、忘記密碼） | 未設定=停用 |
| `ALERT_WEBHOOK_URL` | 異常登入/鎖定/速率限制告警 Webhook | — |
| `REFRESH_TTL_DAYS` / `LOG_LEVEL` | Refresh token 天數 / 日誌等級 | `7` / `info` |

## 安全控管對照
| 需求 | 實作 |
|---|---|
| 密碼雜湊 | Argon2id（`@node-rs/argon2`） |
| Token | Access JWT 15 分鐘；httpOnly + Secure + SameSite=Strict；Refresh 不透明 token 只存雜湊、每次旋轉、重放偵測會撤銷整個 family |
| 授權 | 所有 API 伺服器端檢查 session 與細粒度權限（RBAC：super_admin / admin / viewer / user，可於後台調整） |
| 登入防護 | 連續失敗 5 次鎖定 15 分鐘、IP 速率限制、統一錯誤訊息與耗時（防帳號枚舉） |
| 2FA | TOTP（RFC 6238），選用：於「個人設定」啟用後，登入即需驗證碼 |
| CSRF | SameSite=Strict + 雙重提交 Cookie（`X-CSRF-Token`） |
| 傳輸 / 標頭 | CSP、HSTS（`FORCE_HTTPS`）、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy |
| 資料保護 | TOTP secret 以 AES-256-GCM 加密；稽核日誌由資料庫 trigger 禁止修改/刪除 |
| 輸入驗證 | zod；SQL 參數化；CSV 匯出防公式注入 |
| 日誌 | pino 結構化、敏感欄位 redact、不記錄檔案內容 |
| 供應鏈 | Dependabot + CI `npm audit` |

## 測試
```bash
npm test            # 伺服器（Vitest + Supertest）與前端 PDF 運算層（Vitest）
```

## iOS / PWA 注意事項
- 以 Safari 開啟 → 分享 → 「加入主畫面」即可全螢幕獨立執行（已設定 `apple-touch-icon` 180×180、`apple-mobile-web-app-capable`、`status-bar-style`、`viewport-fit=cover`）。
- 下載按鈕旁提供「分享 / 存到檔案」（Web Share API），可直接存到「檔案」App。
- 選檔支援「檔案」App 與相簿；大型檔案逐頁處理並即時釋放 canvas / Blob URL。
- 離線：App Shell 與已使用過的 OCR 語言資料會被快取；伺服器端轉檔與登入需要網路。

## 專案結構
```
web/      React + TS + Vite + Tailwind（tools/ops 為純函式 PDF 運算，可在 Node 測試）
server/   Express 5 + zod + PostgreSQL/PGlite（auth、rbac、admin）
docs/     架構、ERD、已知限制、維運
```
