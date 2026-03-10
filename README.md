# Minsah Proxy Server

Google Sheet URL গুলো সম্পূর্ণ লুকানো — browser কখনো দেখতে পাবে না।

## Architecture
```
Browser → Proxy Server → Google Sheet
                       → n8n (inbox)
```

## Dokploy Environment Variables

এই variables Dokploy → Environment এ দাও:

| Variable | Value |
|---|---|
| STOCK_SHEET_URL | তোমার stock Google Apps Script URL |
| SHOP_SHEET_URL | তোমার shop Google Apps Script URL (same sheet হলে same URL) |
| INBOX_SHEET_URL | তোমার inbox Google Apps Script URL |
| N8N_REPLY_URL | https://shopperzz-n8n-926afe-93-127-166-227.traefik.me/webhook/minsah-reply |
| WHATSAPP_NUMBER | 8801XXXXXXXXX |
| ADMIN_PASSWORD | তোমার admin password (default: minsah2024) |

## Security
- ✅ Sheet URL browser এ visible না
- ✅ Buy price shop এ দেখা যাবে না  
- ✅ Admin routes password protected
- ✅ CORS শুধু তোমার domain থেকে

## Deploy
1. এই folder টা GitHub repo তে push করো
2. Dokploy → New Service → Docker Compose
3. Environment Variables দাও
4. Deploy করো

## Access
- Admin: https://stock.minsahbeauty.cloud/admin
- Shop: https://shop.minsahbeauty.cloud
