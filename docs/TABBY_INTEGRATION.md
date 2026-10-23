# Tabby Pay-in-4 Integration

Tabby is an **additional** payment method alongside **COD** and **MyFatoorah**. Nothing was removed.

## Customer flow

1. Checkout selects **Pay in 4 with Tabby** (`paymentMethod: TABBY`)
2. Order is created as `PENDING_PAYMENT` / `UNPAID` (cart kept)
3. `POST /orders/:id/pay` (or `/guest-pay`) creates a Tabby session → returns `paymentUrl`
4. Browser redirects to Tabby HPP
5. On return / webhook: backend `GET` payment → if `AUTHORIZED` → **capture** → mark `PAID` → `PROCESSING`

## Env vars

See `.env.example` (`TABBY_*`). Sandbox keys came from Tabby onboarding; swap to live `sk_` / `pk_` after Tabby approves.

Webhook registration (once you have a public URL):

```bash
curl -X POST https://api.tabby.ai/api/v1/webhooks \
  -H "Authorization: Bearer $TABBY_SECRET_KEY" \
  -H "X-Merchant-Code: AmoonBloom" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-API/api/v1/orders/payment/tabby/webhook",
    "header": { "title": "X-Tabby-Auth", "value": "YOUR_TABBY_WEBHOOK_SECRET" }
  }'
```

## Admin

Per region: enable **Tabby (Pay in 4)** on the region form (`tabbyEnabled`). Independent of MyFatoorah “online payment”.

## Endpoints

| Method | Path | Role |
| --- | --- | --- |
| GET | `/orders/payment/tabby/callback` | Success return |
| GET | `/orders/payment/tabby/cancel` | Cancel return |
| GET | `/orders/payment/tabby/failure` | Failure return |
| POST | `/orders/payment/tabby/webhook` | Async confirmation |

## Currency note

Current sandbox keys from Tabby (`tabby.sa` / merchant `AmoonBloom`) accept **SAR only**.
`TABBY_CURRENCIES=SAR` enforces this. UAE (AED) should keep `tabbyEnabled=false` until Tabby
issues AED / multi-currency keys.

## Security checklist (implemented)

- Secret key stays on the server only (never in the Next.js frontend)
- Browser return never trusted alone — always `GET /payments/{id}` then capture
- Amount + currency verified **before** capture and before marking `PAID`
- Capture idempotent via `reference_id=capture-{orderId}`
- Open-redirect guard on `ret` (same allowlist as MyFatoorah)
- Webhook auth: `TABBY_WEBHOOK_SECRET` required when `NODE_ENV=production`
- Buyer email + phone required (no fake fallbacks)
- Existing payment methods (`COD`, `MYFATOORAH`) unchanged

## Testing

- [Tabby testing guidelines](https://docs.tabby.ai/testing-guidelines)
- [Full testing checklist](https://docs.tabby.ai/pay-in-4-custom-integration/full-testing-checklist)
- Test buyer: `otp.success@tabby.ai` / `+966500000001` (KSA) — OTP `8888`
- Smoke script: `node scripts/verify-tabby-integration.js`
