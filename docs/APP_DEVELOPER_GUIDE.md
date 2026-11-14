# Amoon Bloom — App Developer Guide (single source of truth)

**Date:** 2026-11-14  
**Audience:** Mobile app developers  
**Base URL:** `/api/v1`  
**Repo:** `amoonbloom/amoonbloom-backend`

Share **this one file** with the app team. It includes:

- Everything we **built / fixed** (wishlist, auth flags, address 409, quote promo, notifications, delivery-days range, region sale/gift, …)
- Answers to **all original backend questions**
- How the app must show **prices, sale badges, and gift options by region**

---

## Table of contents

1. [Wishlist (guest + logged-in + keep after login)](#1-wishlist-guest--logged-in--keep-after-login)  
2. [Guest orders → account history](#2-guest-orders--account-history)  
3. [National Address / short address](#3-national-address--short-address)  
4. [Delivery days range (within N vs N to M)](#4-delivery-days-range-within-n-vs-n-to-m)  
5. [Region-wise prices, sale & gift options](#5-region-wise-prices-sale--gift-options)  
6. [Fixes from your Q&A](#6-fixes-from-your-qa)  
7. [Full Q&A answers (1–20)](#7-full-qa-answers-120)  
8. [App integration checklist](#8-app-integration-checklist)

---

## 1. Wishlist (guest + logged-in + keep after login)

Wishlist is **server-side** (no longer local-only).

| Who | Identity |
|-----|----------|
| Guest | Header `X-Guest-Token: <uuid>` (generate once, store on device) |
| Logged-in | `Authorization: Bearer <token>` |

Also send `X-Region` for correct prices.

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/wishlist` | optional | List |
| `POST` | `/wishlist` | optional | Add `{ productId, selectedOptions? }` |
| `DELETE` | `/wishlist/{productId}` | optional | Remove one (optional `variantKey`) |
| `DELETE` | `/wishlist` | optional | Clear all |
| `POST` | `/wishlist/claim` | **required** | Merge guest list into account |

Limit: **100** items → **409** if exceeded.  
Add is idempotent: already present → **200** `"Already in wishlist"`.

### Guest token

```text
1. First launch → generate UUID v4, persist forever
2. Send X-Guest-Token on every guest wishlist call
3. On signup / signin / Google / Apple → send the SAME token
   (or call POST /wishlist/claim right after login)
4. Server unions guest items into the user wishlist and deletes guest rows
```

### Sample `GET /wishlist`

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "row-uuid",
        "productId": "product-uuid",
        "selectedOptions": { "Size": "Large" },
        "variantKey": "Size=Large",
        "createdAt": "2026-11-14T12:00:00.000Z",
        "product": {
          "id": "product-uuid",
          "title": "Rose Box",
          "price": 280,
          "discountedPrice": 240,
          "image": "https://...",
          "resolvedDeliveryLeadDays": 3,
          "resolvedDeliveryLeadDaysMax": 5
        }
      }
    ],
    "totalItems": 1,
    "currency": "SAR"
  }
}
```

Guest without token → **400** needing `X-Guest-Token`.

---

## 2. Guest orders → account history

**Already built** (no new API). Same idea as wishlist continuity:

1. Guest checkout should send **email**.  
2. On signup / signin / Google / Apple with **the same email**, the server attaches those orders (`userId` was null → now the account).  
3. They appear in `GET /orders/history`.  
4. Before login, tracking still works via `GET /orders/{id}/status` (order id is the credential).

```text
Guest checkout (email: a@x.com)
        ↓
Later login / signup with a@x.com
        ↓
GET /orders/history includes those orders
```

Wishlist needs the **device guest token**. Orders need the **same email**.

---

## 3. National Address / short address

### Admin controls it per region

| `shortAddressEnabled` | Checkout address page |
|-----------------------|------------------------|
| **`true`** | **Show** National Address / Short Address and make it **required** |
| **`false`** | **Do not show**; do not send (or empty OK) |

- Admin toggles via `PUT /regions/{id}` `{ "shortAddressEnabled": true|false }`.  
- Default in DB is **`false`**.  
- Intended: **SA = true**, others **false** — but always **read `GET /regions`**, don’t hardcode.  
- If the field is missing somehow → treat as **`false`** (never assume true).

### Checkout payload

Top-level field (not inside `shippingAddress`):

```json
{
  "shippingAddress": { "...": "..." },
  "shortAddress": "JHRC3674"
}
```

Format: 4 letters + 4 digits (`JHRC3674`, optional space/hyphen).  
Missing when required → **400** `"shortAddress is required"`.

---

## 4. Delivery days range (within N vs N to M)

### What changed

Previously admin could set only **one** number on the region (`standardDeliveryDays`: 3 or 5 or 6).

Now admin can set **two** options:

| Admin sets | App shows |
|------------|-----------|
| Only min, e.g. `standardDeliveryDays: 3` | **within 3 days** (same as today) |
| Min + max, e.g. `3` and `5` | **3 to 5 days** |

Scheduling / earliest delivery math still uses the **min** (soonest). Max is for **display**.

### Region fields (`GET /regions`, create/update)

```json
{
  "code": "UAE",
  "standardDeliveryDays": 3,
  "standardDeliveryDaysMax": 5
}
```

| Field | Meaning |
|-------|---------|
| `standardDeliveryDays` | Lower bound **or** sole value. `null` = no ETA. |
| `standardDeliveryDaysMax` | Optional upper bound. `null` = single-value UI. Must be **≥ min** when set. Equal to min → stored as single (max cleared). |

**Admin update examples:**

```json
{ "standardDeliveryDays": 3, "standardDeliveryDaysMax": 5 }
```

```json
{ "standardDeliveryDays": 3, "standardDeliveryDaysMax": null }
```

### Zones (optional override)

Same idea on delivery zones:

- `standardLeadDays` / `standardLeadDaysMax`  
- `null` inherits the region.

### Product / wishlist / cart display fields

On mapped products the API also exposes:

| Field | Meaning |
|-------|---------|
| `resolvedDeliveryLeadDays` | Number to use as the lower / sole value |
| `resolvedDeliveryLeadDaysMax` | Upper bound, or `null` if single |

Product/category overrides are always a **single** day (max stays `null`). The range appears when the ETA falls through to **region/zone standard**.

### App display helper (recommended)

```text
min = region.standardDeliveryDays
     OR product.resolvedDeliveryLeadDays
max = region.standardDeliveryDaysMax
     OR product.resolvedDeliveryLeadDaysMax

if min == null → hide ETA
else if max != null && max > min → "{min} to {max} days"
else → "within {min} days"   // use "day" when min === 1 if you want
```

Arabic copy is up to the app; numbers come from the API.

---

## 5. Region-wise prices, sale & gift options

**Always send `X-Region: UAE` or `X-Region: SA` (etc.) on catalogue, product detail, cart, wishlist, quote, and checkout.**  
The API merges that region’s values into the **top-level** product fields. Do **not** dig into admin `regionPrices[]` on the storefront.

### 5.1 Prices (already region-aware)

Storefront product / cart / wishlist responses already return the **region’s** money fields:

| Field | Meaning for current `X-Region` |
|-------|--------------------------------|
| `price` | Region price (or base if no override) |
| `discountedPrice` | Region sale/list discount for that region (`null` = no discount **here**) |
| `currency` | Region currency (AED / SAR / …) |

```text
X-Region: SA  →  SAR prices for Saudi
X-Region: UAE →  AED prices for UAE
```

**App rule:** render whatever `price` / `discountedPrice` / `currency` the API returns for that request. Do not cache one region’s prices and show them under another region.

### 5.2 Sale badge — per region (admin chooses which regions)

Sale is **not** “one box for every region forever.” Admin can mark sale:

| Admin payload | Effect |
|---------------|--------|
| `onSaleRegionIds: ["<uae-uuid>", "<sa-uuid>"]` | On sale in those regions only |
| `onSaleRegionIds: []` | Off everywhere |
| `onSale: true` (legacy) | On sale in **all** regions the product is sold in |

Admin product GET returns `onSaleRegionIds` so the panel can show a multi-region picker (or “all regions”).

**Storefront (app):** for the current `X-Region`, read top-level:

| Field | Use |
|-------|-----|
| `onSale` | `true` → show Sale badge for **this** region |
| `saleLabel` / `saleLabel_ar` | Custom badge text (or default “Sale” if null) |

`onSale` is already resolved for the requesting region (product region flag OR category OR on-sale section).  
**Do not** show a sale badge from another region’s data.

### 5.3 Gift options (gift card message + custom name) — region-wise

Gift options are region-aware for both **enable** and **price**.

#### Global product defaults (admin)

- `giftCardEnabled` / `giftCardExtraPrice` / `giftCardMode`
- `customNameEnabled` / `customNamePrice`

#### Per-region overrides (`regionPrices[]` on create/update)

```json
{
  "regionPrices": [
    {
      "regionId": "uae-uuid",
      "price": 250,
      "giftCardEnabled": true,
      "giftCardExtraPrice": 0,
      "customNameEnabled": true,
      "customNamePrice": 15
    },
    {
      "regionId": "sa-uuid",
      "price": 280,
      "giftCardEnabled": false,
      "customNameEnabled": true,
      "customNamePrice": 20
    }
  ]
}
```

| Per-region field | Meaning |
|------------------|---------|
| `giftCardEnabled` | `null` = inherit product global; `true`/`false` = override for this region |
| `customNameEnabled` | same |
| `giftCardExtraPrice` | `null` = inherit global price; number = region charge |
| `customNamePrice` | same |

#### What the app sees (storefront, after `X-Region`)

Top-level fields are already merged for that region:

```json
{
  "giftCardEnabled": true,
  "giftCardExtraPrice": 0,
  "customNameEnabled": true,
  "customNamePrice": 20,
  "onSale": true,
  "saleLabel": "Eid Sale",
  "price": 280,
  "discountedPrice": 240,
  "currency": "SAR"
}
```

**App rules:**

1. Show gift-card UI only if `giftCardEnabled === true`.  
2. Show custom-name UI only if `customNameEnabled === true`.  
3. Display / charge using `giftCardExtraPrice` and `customNamePrice` from the same response.  
4. Cart `lineTotal` and `POST /orders/quote` already use these region values — trust the API totals.

### 5.4 Admin summary (for the admin panel team)

| Feature | How to set “all regions” | How to set per region |
|---------|--------------------------|------------------------|
| Sale badge | `onSale: true` **or** pass every id in `onSaleRegionIds` | `onSaleRegionIds: [only some ids]` |
| Gift enable / price | Product-level `giftCardEnabled` / prices | `regionPrices[].giftCardEnabled` / `giftCardExtraPrice` etc. |
| Custom name enable / price | Product-level flags | `regionPrices[].customNameEnabled` / `customNamePrice` |

---

## 6. Fixes from your Q&A

### 6.1 Address limit → 409 (was 500)

11th address:

```json
{ "success": false, "message": "You can save up to 10 addresses" }
```

**HTTP 409.** Cap = 10.

### 6.2 Auth flags on login + profile

On signup / signin / Google / Apple (`data.user`) and `GET /user/profile` (`data`):

```json
{
  "hasPassword": true,
  "isGoogleUser": false,
  "isAppleUser": false
}
```

No `authProvider` string — derive client-side. You can stop calling `GET /auth/user/:userId` just for these.

### 6.3 Mark notification read — idempotent

`PATCH /notifications/{id}/read`

| Case | Status |
|------|--------|
| First read | **200** `{ "alreadyRead": false }` |
| Already read | **200** `{ "alreadyRead": true }` |
| Missing / not yours | **404** |

### 6.4 Quote `promoError`

`POST /orders/quote` still **200** with discount 0 on a bad promo, but now:

```json
"promoError": { "code": "PROMO_EXPIRED", "message": "This promo code has expired" }
```

Good / no promo → `"promoError": null`. Checkout still fails with the same `PROMO_*` codes.

### 6.5 Product image limit

Max **20** images (validator + swagger). `images: []` on PUT clears the gallery (intentional).

---

## 7. Full Q&A answers (1–20)

### ★ 1. Wishlist — still local-only?

**Was.** Now **server wishlist** exists (Section 1). Guests + users; merge on login via `X-Guest-Token`.

### ★ 2. Which regions have `shortAddressEnabled = true`? Does `GET /regions` always return it?

Intended: **SA = true**, others **false**. Field is always a boolean on `GET /regions`. Read it; don’t hardcode.

### 3. Can the column default stay `false`?

**Yes.** App must treat missing as **false**, never true.

### ★ 4. `X-Zone` — English name? Same name in two regions?

Send English **`name`** from `GET /delivery-zones` for the current region. Matching is case-insensitive **within `X-Region`**, so duplicate names across regions are fine.

### 5. `?zoneId=` vs `X-Zone` long-term?

Both supported. Prefer **`X-Zone: <name>`** (or `?zone=`) long-term; `?zoneId=` OK when you already have the id.

### ★ 6. Per-region gift/custom prices on products + quote?

Yes. Storefront merges into top-level `giftCardExtraPrice` / `customNamePrice`. Quote uses the same resolvers as cart/checkout.

### 7. Is cart `lineTotal` the per-line price?

**Yes** — includes variant + gift/custom add-ons. **Does not** include cash-arrangement fee.

### 8. Admin `regionPrices[]` — lead days, cash fees, sample?

Admin create/update accept and return `deliveryLeadDays`, cash fee fields, `giftCardExtraPrice`, `customNamePrice` per region entry. See product admin payloads in swagger.

### ★ 9. `pay-session` 402 `paymentUrl`?

URL in `errors[]` only for non-direct / 3-DS style flows. **Apple Pay → usually `null`.** Treat 402 without URL as declined/retry, don’t open a webview.

### 10. Polling status — is PROCESSING = paid? COD?

**No.** Safest: **`paymentStatus === "PAID"`**. COD can be `PROCESSING` + `UNPAID`.

### 11. `POST /orders/:id/guest-pay` for mobile guests?

**Yes**, for guest `MYFATOORAH` orders only. Safe for that path. Authed users use `/pay`.

### 12. Quote ignore promo vs checkout fail?

**Fixed:** quote now returns `promoError` (Section 6.4). Quote still succeeds with 200.

### ★ 13. 11th address → 500?

**Fixed:** now **409** with clear message (Section 6.1).

### ★ 14. `hasPassword` / provider on sign-in and profile?

**Fixed:** flags on signup/signin/Google/Apple/`GET /user/profile` (Section 6.2). No `authProvider` string.

### 15. Refresh statuses?

Spent/expired → **401** (sign out). Deactivated → **403**. Rate limit → **429**. Server → **5xx** (retry).

### 16. Mark-read already-read → 404?

**Fixed:** idempotent **200** (Section 6.3).

### 17. Image limit 10 or 20?

**20** is correct.

### 18. `images: []` deletes all?

**Yes**, intentional wholesale replace.

### 19. Malware commit — what / redeploy / secrets?

Obfuscated payload stripped from `address.routes.js` / `api.js`. No app API change. Ops should confirm Railway redeploy + secret rotation.

### 20. Removed / renamed routes?

None found that should break current mobile clients. Prefer live swagger if something 404s.

---

## 8. App integration checklist

- [ ] Persist `X-Guest-Token`; use for guest wishlist  
- [ ] Send guest token on login (or `/wishlist/claim`) so wishlist survives login  
- [ ] Collect email on guest checkout so orders appear in history after login  
- [ ] Short address: show + require **only if** `shortAddressEnabled === true`  
- [ ] Delivery ETA: use min/max → “within N days” vs “N to M days”  
- [ ] **Always send `X-Region`** — show `price` / `discountedPrice` / `currency` from that response  
- [ ] Sale badge only when `onSale === true` for current region; use `saleLabel` / `saleLabel_ar`  
- [ ] Gift card UI only if `giftCardEnabled`; custom name only if `customNameEnabled`  
- [ ] Use region `giftCardExtraPrice` / `customNamePrice` for add-on charges  
- [ ] Address create: handle **409** at 10 addresses  
- [ ] Use `hasPassword` / `isGoogleUser` / `isAppleUser` from login/profile  
- [ ] Notification mark-read: expect **200** when already read  
- [ ] Quote: show `promoError.message` when present  
- [ ] Online paid = `paymentStatus === "PAID"`  
- [ ] Zones: send English `name` in `X-Zone` with matching `X-Region`  

### Headers

| Header | When |
|--------|------|
| `Authorization: Bearer …` | Logged-in |
| `X-Region: UAE` \| `SA` | Catalogue, cart, wishlist, checkout |
| `X-Zone: <English name>` | Zone-aware catalogue |
| `X-Guest-Token: <uuid>` | Guest wishlist + claim on login |

---

## Deploy notes (backend / ops)

Run migrations (wishlist + per-region gift enable; delivery range + Moyasar may already be applied):

```bash
npx prisma migrate deploy
```

New / changed surfaces for this release:

| Area | What |
|------|------|
| Wishlist | `/wishlist`, `/wishlist/claim`, auto-claim on auth |
| Region | `standardDeliveryDaysMax` (ETA range) |
| Zone | `standardLeadDaysMax` |
| Products | `resolvedDeliveryLeadDaysMax` |
| Sale | per-region via `onSaleRegionIds` (storefront `onSale` already region-scoped) |
| Gift options | per-region enable + price (`regionPrices[].giftCardEnabled` / `customNameEnabled` / prices) |
| Addresses | create limit → 409 |
| Auth / profile | `hasPassword`, `isGoogleUser`, `isAppleUser` |
| Notifications | mark-read idempotent |
| Quote | `promoError` |

---

Questions: reply with the endpoint + sample body/response. This file is the only handoff doc the app team needs for these changes.
