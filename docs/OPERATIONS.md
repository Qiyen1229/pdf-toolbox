# 維運：備份、還原與安全檢查

## 備份策略
| 項目 | 內容 | 方法 | 頻率 |
|---|---|---|---|
| PostgreSQL | 帳號、稽核日誌、設定、用量 | `pg_dump` | 每日 |
| `.env` | JWT_SECRET、**APP_ENC_KEY**、SMTP | 離線保存（密碼管理器 / 加密 USB） | 變更時 |

> 不需要備份檔案內容：系統**不儲存**使用者檔案。
> **APP_ENC_KEY 遺失 = 所有 TOTP 無法解密**（使用者需由管理者重設）。務必與資料庫備份分開保管。

### 手動備份
```bash
docker compose exec -T db pg_dump -U pdftool -Fc pdftool > backup-$(date +%F).dump
```

### NAS 排程
在 Synology「工作排程器」新增每日使用者自訂指令碼（以 `docker compose` 所在資料夾為工作目錄），內容為上方指令並把檔案寫入受保護的共用資料夾；保留 14 天。

## 還原測試（建議每季演練一次）
```bash
# 1. 建立臨時資料庫並還原
docker compose exec -T db createdb -U pdftool restore_test
docker compose exec -T db pg_restore -U pdftool -d restore_test --no-owner < backup-YYYY-MM-DD.dump

# 2. 驗證資料筆數
docker compose exec -T db psql -U pdftool -d restore_test -c "select count(*) from users;"
docker compose exec -T db psql -U pdftool -d restore_test -c "select count(*) from audit_logs;"

# 3. 驗證稽核日誌不可變（應回報 audit_logs is append-only）
docker compose exec -T db psql -U pdftool -d restore_test -c "delete from audit_logs;"

# 4. 清除
docker compose exec -T db dropdb -U pdftool restore_test
```
真正還原到正式庫：先 `docker compose stop app`，`dropdb`/`createdb` 後 `pg_restore -d pdftool`，再 `docker compose start app`。

## 初始化管理者
```bash
docker compose exec app node dist/cli/create-admin.js --email admin@example.com
# 未設定 ADMIN_PASSWORD 時會印出一次性隨機密碼
```
忘記管理者密碼或 2FA 裝置遺失：對同一 Email 重跑上述指令 = 重設為新的一次性密碼並**清除舊的 TOTP**，TOTP 需於個人設定重新啟用。

## 安全檢查清單
- [ ] `.env` 中所有 `CHANGE_ME` 已更換為隨機值
- [ ] 以 HTTPS 對外（反向代理），`COOKIE_SECURE=true`
- [ ] `ADMIN_IP_ALLOWLIST` 限制後台來源（建議只允許區網）
- [ ] 設定 `ALERT_WEBHOOK_URL`，接收鎖定 / 異常登入 / 速率限制告警
- [ ] 定期 `npm audit --omit=dev`（CI 已排入）與 Dependabot PR
- [ ] 每季還原演練
- [ ] 資料庫埠（5432）不對外開放
- [ ] 日誌確認不含密碼 / Token / 檔案內容（pino redact 已設定）

## 稽核日誌
- 資料表 `audit_logs` 由資料庫 trigger 禁止 `UPDATE / DELETE / TRUNCATE`；管理後台只能檢視與匯出 CSV。
- 事件：登入成功/失敗/鎖定、新 IP 管理者登入、密碼變更與重設、TOTP 啟用/停用、角色與權限變更、功能開關、系統設定、公告、強制登出、日誌匯出。
