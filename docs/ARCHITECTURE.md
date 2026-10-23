# PDF 工具箱 — 系統架構與資料庫 ERD

## 1. 系統架構

```mermaid
flowchart LR
  subgraph Browser["使用者瀏覽器 / iOS Safari PWA"]
    UI["React + Vite SPA<br/>Tailwind / 深色模式"]
    SW["Service Worker<br/>(離線 App Shell)"]
    WK["PDF 引擎 (本機運算)<br/>pdf-lib · pdf.js · Tesseract.js · qpdf-wasm"]
    UI --> WK
    SW -.-> UI
  end
  subgraph Server["Node.js / Express (port 9133)"]
    SEC["helmet · CSP · CSRF · rate limit"]
    AUTH["Auth: Argon2id · JWT cookie · TOTP"]
    RBAC["RBAC 細粒度權限"]
    API["REST API: users / admin / audit / features / usage"]
    STATIC["靜態檔案 (web/dist)"]
  end
  DB[("PostgreSQL<br/>(開發模式: PGlite)")]
  UI -- "HTTPS + httpOnly Cookie" --> SEC --> AUTH --> RBAC --> API --> DB
```

### 設計原則
| 原則 | 實作 |
|---|---|
| 檔案預設不離開裝置 | 合併、分割、壓縮、浮水印、OCR、加密、塗黑…全部在瀏覽器完成 |
| 伺服器只存「元資料」 | 帳號、設定、稽核日誌、用量統計（僅工具名稱/大小區間），**不存檔案內容** |
| 授權永遠在伺服器 | 所有 `/api/*` 以 middleware 檢查 session + 權限，前端僅負責顯示 |

### 模組劃分
```
web/    React SPA（tools/ 工具引擎、pages/、components/、lib/）
server/ Express API（auth、rbac、admin、db、security）
docs/   架構、ERD、已知限制
```

## 2. 資料庫 ERD

```mermaid
erDiagram
  roles ||--o{ users : "has"
  roles ||--o{ role_permissions : "grants"
  permissions ||--o{ role_permissions : ""
  users ||--o{ refresh_tokens : "owns"
  users ||--o{ password_resets : "requests"
  users ||--o{ usage_events : "performs"
  users ||--o{ audit_logs : "actor"
  users ||--o{ user_preferences : "has"
  feature_flags }o--o{ roles : "allowed_roles"

  users {
    uuid id PK
    citext email UK
    text password_hash "Argon2id"
    text role FK
    bool is_active
    bool email_verified
    bool must_change_password
    text totp_secret_enc "AES-256-GCM"
    bool totp_enabled
    int failed_logins
    timestamptz locked_until
    int token_version "強制登出"
    timestamptz created_at
  }
  roles { text name PK  text description }
  permissions { text key PK  text description }
  role_permissions { text role FK  text permission FK }
  refresh_tokens {
    uuid id PK
    uuid user_id FK
    text token_hash UK "SHA-256"
    timestamptz expires_at
    timestamptz revoked_at
    text user_agent
  }
  password_resets { uuid id PK  uuid user_id FK  text token_hash  timestamptz expires_at  timestamptz used_at }
  user_preferences { uuid user_id PK  text language  text theme  text output_quality }
  feature_flags { text tool_id PK  bool enabled  text[] allowed_roles }
  usage_events { bigint id PK  uuid user_id  text tool_id  text size_bucket  timestamptz at }
  audit_logs {
    bigint id PK
    uuid actor_id
    text action
    text target
    jsonb detail
    inet ip
    timestamptz at "UPDATE/DELETE 由 trigger 禁止"
  }
  announcements { uuid id PK  text title  text body  text level  bool active  timestamptz created_at }
  system_settings { text key PK  jsonb value }
```

### 關鍵約束
- `audit_logs`：資料庫 trigger 拒絕 `UPDATE` / `DELETE` / `TRUNCATE`（任何角色皆不可刪除，只能由 DBA 以備份策略管理）。
- `users.totp_secret_enc`：AES-256-GCM（`APP_ENC_KEY` 由環境變數/KMS 提供）。
- `refresh_tokens`：只存雜湊；旋轉（rotation）＋可撤銷；偵測重放時撤銷整個 token family（使用者全部 refresh）。
- `token_version`：管理者「強制登出」時遞增，使既有 access token 立即失效。

## 3. 認證流程
1. 登入：Argon2id 驗證 → （若啟用 TOTP）要求 6 位數 → 設定 `access`（15 分鐘）與 `refresh`（7 天）httpOnly+Secure+SameSite=Strict Cookie，另發 `csrf` Cookie（雙重提交）。
2. 呼叫 API：`X-CSRF-Token` 必須等於 `csrf` Cookie；access 過期時前端呼叫 `/api/auth/refresh`（旋轉）。
3. 連續 5 次失敗鎖定 15 分鐘；每 IP 速率限制。
4. 管理者首次登入：`must_change_password` 與強制 TOTP 設定，未完成前僅能存取 `/api/auth/*`。

## 4. 實作順序
基礎框架 → 認證與 RBAC → PDF 核心工具 → 進階工具 → 管理後台 → 資安加固 → PWA 與 iOS 驗證。
