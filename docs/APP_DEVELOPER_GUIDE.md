# Amoon Bloom — App Developer Guide

**Date:** 14 Nov 2026  
**Audience:** Mobile app developers  
**Base URL:** `/api/v1`  
**This is the only document you need** for this backend release.

Hi team — please read this end to end before your next app release. It covers everything that shipped, what you must change in the app, sample payloads, and answers to the earlier backend Q&A.

---

## What you must implement (quick list)

1. **Server wishlist** — guests use `X-Guest-Token`; merge into the account on login (same idea as guest orders + email).
2. **National Address** — show / require short address **only when** `shortAddressEnabled === true` on the region.
3. **Delivery ETA range** — if max is set and greater than min, show **“N to M days”**; otherwise **“within N days”**.
4. **Always send `X-Region`** — prices, sale badge, currency, and gift options are all **region-specific**. Trust the top-level fields on each response; do not reuse another region’s cached product payload.
5. **Sale** — show the sale badge only when `onSale === true` for the current region (`saleLabel` / `saleLabel_ar` for copy).
6. **Gift card + custom name** — show each option only if that region’s enable flag is true; use that region’s add-on prices.
7. **Addresses** — 11th address returns **409** (not 500).
8. **Auth / profile** — use `hasPassword`, `isGoogleUser`, `isAppleUser`.
9. **Notifications** — mark-read of an already-read item returns **200**.
10. **Quote** — if a promo is invalid, read `promoError.message` (quote still returns 200).
11. **Paid online** — treat as paid when `paymentStatus === "PAID"` (not by order status alone).
12. **COD** — new COD orders are created as `status: "PROCESSING"` (not `PENDING_PAYMENT`). Do **not** show “Pending payment” for COD.
13. **History list** — `GET /orders/history` includes `paymentMethod` + `paymentStatus` on each row.
14. **Order detail screen** — when the user opens an order, show **every** field returned (notes, payment, shipping date, line gifts, cash arrangement, address, totals). See Section 9.
15. **Order statuses** — support all 8 WooCommerce-style statuses (labels below). Do not use the old Confirmed / Shipped / Delivered set.

### Headers (every storefront call that needs them)

| Header | Use |
|--------|-----|
| `Authorization: Bearer …` | Logged-in calls |
| `X-Region: UAE` or `SA` | Catalogue, product, cart, wishlist, quote, checkout |
| `X-Zone: <English zone name>` | Zone-aware catalogue |
| `X-Guest-Token: <uuid>` | Guest wishlist + claim on login |

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
9. [Order detail screen — show everything](#9-order-detail-screen--show-everything)  
10. [Order statuses (must support all 8)](#10-order-statuses-must-support-all-8)

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
          "currency": "SAR",
          "onSale": true,
          "saleLabel": "Eid Sale",
          "giftCardEnabled": true,
          "giftCardExtraPrice": 0,
          "customNameEnabled": true,
          "customNamePrice": 20,
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

### 5.4 How to display a product (app rule of thumb)

For the current region response, use **only** these top-level fields:

| Show | From |
|------|------|
| List / detail price | `price`, `discountedPrice`, `currency` |
| Sale badge | `onSale`, `saleLabel`, `saleLabel_ar` |
| Gift card option | `giftCardEnabled`, `giftCardExtraPrice`, `giftCardMode` |
| Custom name option | `customNameEnabled`, `customNamePrice` |
| ETA | `resolvedDeliveryLeadDays`, `resolvedDeliveryLeadDaysMax` |

If the user switches region, **refetch** catalogue / product / cart with the new `X-Region`. Do not keep showing the previous region’s numbers.

### 5.5 Admin summary (admin panel team)

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

Yes. Storefront merges into top-level `giftCardExtraPrice` / `customNamePrice`. Enable flags are also region-merged (`giftCardEnabled` / `customNameEnabled`). Quote uses the same resolvers as cart/checkout.

### 7. Is cart `lineTotal` the per-line price?

**Yes** — includes variant + gift/custom add-ons. **Does not** include cash-arrangement fee.

### 8. Admin `regionPrices[]` — lead days, cash fees, sample?

Admin create/update accept and return `deliveryLeadDays`, cash fee fields, `giftCardExtraPrice`, `customNamePrice`, `giftCardEnabled`, `customNameEnabled` per region entry. See product admin payloads in swagger.

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

Obfuscated payload was stripped from backend files. No app API change. Ops should confirm Railway redeploy + secret rotation.

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
- [ ] On region switch → refetch products/cart (do not reuse old region prices)  
- [ ] Address create: handle **409** at 10 addresses  
- [ ] Use `hasPassword` / `isGoogleUser` / `isAppleUser` from login/profile  
- [ ] Notification mark-read: expect **200** when already read  
- [ ] Quote: show `promoError.message` when present  
- [ ] Online paid = `paymentStatus === "PAID"`  
- [ ] Zones: send English `name` in `X-Zone` with matching `X-Region`  
- [ ] Order detail (`GET /orders/{id}`): show **all** fields — notes, payment, shipping/ETA, lines, gifts, cash arrangement, address, totals (Section 9)  
- [ ] Support all **8** order statuses with correct labels + a default/fallback (Section 10)  
- [ ] COD create → expect `status: "PROCESSING"`; never label new COD as “Pending payment”  
- [ ] History list uses `paymentMethod` + `paymentStatus` from `GET /orders/history`  
- [ ] Do not treat `status === PROCESSING` as paid — use `paymentStatus`  

### Headers (repeat)

| Header | When |
|--------|------|
| `Authorization: Bearer …` | Logged-in |
| `X-Region: UAE` \| `SA` | Catalogue, cart, wishlist, checkout |
| `X-Zone: <English name>` | Zone-aware catalogue |
| `X-Guest-Token: <uuid>` | Guest wishlist + claim on login |

---

## 9. Order detail screen — show everything

When the user **opens / taps an order** (order history → order detail), load full detail and render **every meaningful field**. Do not build a thin summary-only page that hides notes, payment method, shipping date, gift messages, or cash arrangement.

### API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/orders/history` | required | List (summary OK) |
| `GET` | `/orders/{id}` | required | **Full order detail** — use this for the detail screen |

Guest tracking before login still uses `GET /orders/{id}/status` (status + payment only). After login, always use **`GET /orders/{id}`** for the rich screen.

### Rule

> If the API returns a non-null / non-empty value, **show it**. Hide only empty optional fields (null / blank), never hide a whole category just to save space.

### What to show on the detail screen

#### A. Order header

| Field | UI label (EN) | Notes |
|-------|---------------|--------|
| `orderNumber` | Order # | Prefer this over raw `id` when present |
| `id` | — | Keep for deep links / support; can show under “Order ID” |
| `status` | Status | Map with Section 10 labels |
| `paymentStatus` | Payment status | `UNPAID` / `PAID` / `FAILED` — **separate** from order status |
| `paymentMethod` | Payment method | `COD` / `MYFATOORAH` / `MOYASAR` — show friendly names (Cash on delivery, Card / MyFatoorah, Moyasar) |
| `currency` | — | Use on every money field |
| `createdAt` | Placed on | Format in local / region-friendly date-time |
| `updatedAt` | Updated | Optional secondary |

#### B. Notes & messages (do not skip)

| Field | UI label | Notes |
|-------|----------|--------|
| `orderMessage` | Order note / message | Whole-order note from checkout |
| Per line `perProductMessage` | Gift message / product note | When `giftCardSelected` is true this is the gift-card message |
| Per line `customName` | Custom name | Personalized name add-on |
| Per line / order `cashArrangementNote` | Cash arrangement note | Show when cash arrangement was requested |

#### C. Delivery & shipping date

| Field | When to show | UI |
|-------|--------------|-----|
| `deliveryType` | always | `STANDARD` or `SCHEDULED` |
| `scheduledDeliveryAt` | `deliveryType === "SCHEDULED"` | **Chosen shipping / delivery date** (format nicely) |
| `isSameDayDelivery` | when true | Badge: Same-day |
| `estimatedDeliveryDate` | `STANDARD` and not null | **Estimated delivery date** (`YYYY-MM-DD` — display as-is, no TZ shift) |
| `estimatedDeliveryDays` | `STANDARD` and useful | e.g. “within N days” helper text |
| `shippingAddress.*` | when object present | Full address block (below) |

**Shipping address block** (`shippingAddress`):

| Field | Show as |
|-------|---------|
| `fullName` | Recipient name |
| `phone` | Phone |
| `streetAddress` | Street |
| `apartment` | Apt / building |
| `area` | Area |
| `city` / `state` / `postalCode` / `country` | City / state / postal / country |
| `shortAddress` | National Address / short address (when present) |
| `deliveryZoneName` | Zone / emirate |

#### D. Money / totals

Show a clear breakdown (skip a row only if that value is null and not applicable):

| Field | Label |
|-------|--------|
| `subtotalAmount` | Subtotal |
| `discountAmount` | Discount |
| `appliedPromoCode` | Promo code |
| `shippingAmount` | Shipping |
| `taxAmount` / `vatAmount` | VAT / tax |
| `vatRatePercent` | VAT rate % (optional helper) |
| `vatInclusive` | “Prices include VAT” vs “VAT added” |
| `cashArrangementAmount` | Cash to include (when requested) |
| `cashArrangementFeeAmount` | Cash arrangement fee |
| `cashArrangementFeeVatAmount` | Fee VAT (if useful) |
| `totalAmount` | **Total** (emphasize) |

#### E. Cash arrangement (order-level + per line)

When `cashArrangementRequested === true` (order or line):

- Amount, denomination, note, fee, fee VAT  
- Prefer **per-line** values when lines differ; order-level fields are roll-ups

#### F. Line items (every line)

For each `items[]` entry show:

| Field | Label |
|-------|--------|
| `product.title` / `title_ar` | Product name |
| `selectedImage` or product image | Thumbnail |
| `quantity` | Qty |
| `price` | Unit / line price (as you already display) |
| `selectedOptions` | Variant (Size, Colour, …) |
| `giftCardSelected` + `giftCardMode` | Gift card selected + mode |
| `perProductMessage` | Gift / product message |
| `customName` | Custom name |
| `vatRatePercent` / `vatAmount` | Line VAT if you show tax per line |
| `resolvedLeadDays` | Prep lead (optional) |
| Cash arrangement fields on the line | As in E |

If `product.deleted === true`, still show `product.title` from the snapshot — do not blank the line.

#### G. Guest contact (rare on logged-in history)

If present: `guestName`, `guestPhone`, `guestEmail`.

### Sample shape (fields you must be ready to render)

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "orderNumber": 1042,
    "status": "PROCESSING",
    "paymentStatus": "PAID",
    "paymentMethod": "MYFATOORAH",
    "currency": "SAR",
    "orderMessage": "Please call on arrival",
    "deliveryType": "STANDARD",
    "scheduledDeliveryAt": null,
    "isSameDayDelivery": false,
    "estimatedDeliveryDays": 3,
    "estimatedDeliveryDate": "2026-11-17",
    "subtotalAmount": 280,
    "discountAmount": 20,
    "shippingAmount": 15,
    "taxAmount": 41.25,
    "vatAmount": 41.25,
    "vatRatePercent": 15,
    "vatInclusive": false,
    "appliedPromoCode": "WELCOME10",
    "totalAmount": 316.25,
    "cashArrangementRequested": false,
    "shippingAddress": {
      "fullName": "Sara Ali",
      "phone": "+9665…",
      "streetAddress": "…",
      "apartment": "…",
      "area": "Al Olaya",
      "city": "Riyadh",
      "state": null,
      "postalCode": null,
      "country": "SA",
      "shortAddress": "JHRC3674",
      "deliveryZoneName": "Riyadh"
    },
    "createdAt": "2026-11-14T12:00:00.000Z",
    "updatedAt": "2026-11-14T12:05:00.000Z",
    "items": [
      {
        "id": "line-uuid",
        "quantity": 1,
        "price": 280,
        "selectedOptions": { "Size": "Large" },
        "giftCardSelected": true,
        "giftCardMode": "MESSAGE",
        "perProductMessage": "Happy Birthday!",
        "customName": null,
        "product": { "title": "Rose Box", "image": "https://…" }
      }
    ]
  }
}
```

### UX tips

1. History list can stay compact (order #, status, total, date).  
2. Detail screen = **full receipt**.  
3. Never invent fields — only display what the API returns.  
4. `paymentStatus` and `status` are different; show both.  
5. For `STANDARD` delivery highlight `estimatedDeliveryDate`; for `SCHEDULED` highlight `scheduledDeliveryAt`.

---

## 10. Order statuses (must support all 8)

Order lifecycle is WooCommerce-aligned. **`order.status`** uses these API values only:

| API value (`status`) | Show in the app (EN) | Typical meaning |
|----------------------|----------------------|-----------------|
| `PENDING_PAYMENT` | Pending payment | **Online only** at create — waiting for card/Apple Pay. **COD does not use this** anymore. |
| `PROCESSING` | Processing | Being prepared / fulfilled. **COD starts here** at create. Online moves here after pay. |
| `ON_HOLD` | On hold | Paused by admin — **must display**, even if the app never sets it |
| `COMPLETED` | Completed | Done / delivered (replaces old Delivered) |
| `CANCELLED` | Cancelled | Cancelled |
| `REFUNDED` | Refunded | Refunded — **must display** |
| `FAILED` | Failed | Failed order label (admin) — **not** the same as `paymentStatus: "FAILED"` |
| `DRAFT` | Draft | Draft — **must display** |

### Old → new (if you still have hardcoded UI)

| Old (remove) | New |
|--------------|-----|
| `AWAITING_PAYMENT` / `PENDING` | `PENDING_PAYMENT` |
| `CONFIRMED` / `SHIPPED` | `PROCESSING` |
| `DELIVERED` | `COMPLETED` |
| — | `ON_HOLD`, `REFUNDED`, `FAILED`, `DRAFT` (new) |

### Create-time status by payment method

| `paymentMethod` | Initial `status` | Initial `paymentStatus` |
|-----------------|------------------|-------------------------|
| `COD` | **`PROCESSING`** | `UNPAID` |
| `MYFATOORAH` / `MOYASAR` | `PENDING_PAYMENT` | `UNPAID` → `PAID` when gateway confirms |

### App rules

1. Update every `switch` / stepper / filter / push deep-link that matches status strings.  
2. Always include a **default / fallback** so unknown values don’t crash.  
3. Progress UI (if any): online **Pending payment → Processing → Completed**; COD often starts at **Processing**.  
4. Do **not** treat `PROCESSING` as “paid”. Paid = `paymentStatus === "PAID"`.  
5. Do **not** show “Pending payment” for COD (new orders are already `PROCESSING`).  
6. History filters (`?status=`) must send the new enum values only — old names return **400**.  
7. `GET /orders/history` rows include `paymentMethod` + `paymentStatus` — use them for list labels.  
8. Push / inbox: COD `ORDER_PLACED` carries `status: "PROCESSING"`.

### Payment status (separate field)

| `paymentStatus` | Meaning |
|-----------------|--------|
| `UNPAID` | Not paid yet (normal for COD until collected) |
| `PAID` | Online payment confirmed |
| `FAILED` | Online payment failed |

---

## What shipped on the backend (for your awareness)

| Area | What |
|------|------|
| Wishlist | `/wishlist`, `/wishlist/claim`, auto-claim on auth |
| Region | `standardDeliveryDaysMax` (ETA range) |
| Zone | `standardLeadDaysMax` |
| Products | `resolvedDeliveryLeadDaysMax` |
| Sale | per-region via `onSaleRegionIds` (storefront `onSale` already region-scoped) |
| Gift options | per-region enable + price |
| Addresses | create limit → **409** |
| Auth / profile | `hasPassword`, `isGoogleUser`, `isAppleUser` |
| Notifications | mark-read idempotent |
| Quote | `promoError` |
| Orders | Full detail via `GET /orders/{id}`; 8 statuses; COD → `PROCESSING` at create; history includes `paymentMethod` / `paymentStatus` |

---

Questions: reply with the endpoint + sample body/response. **This single file is the full handoff** — you do not need any other doc for these changes.
