# App team update — Quote now includes cash arrangement + how to show the breakdown

**Date:** 15 Nov 2026  
**Share this one file** with the mobile team for this change.

Hi team,

`POST /orders/quote` used to **exclude** cash arrangement, while checkout **included** it. That made the bag/checkout footer show one amount (e.g. **474**) and Apple Pay / the created order show another (e.g. **914**).

That is fixed. Quote now prices cash the **same way** as checkout.

---

## 1. What changed on `POST /orders/quote`

### Still returned (unchanged meaning)

| Field | Meaning |
|-------|---------|
| `subtotalAmount` | Merchandise only (product + gift/custom name extras × qty), before cash |
| `discountAmount` | Promo discount on merchandise |
| `shippingAmount` | Flat shipping (VAT-inclusive fee) |
| `taxAmount` | Merchandise VAT |
| `vatRatePercent` / `vatInclusive` | Region VAT config for labels |
| **`totalAmount`** | **Legacy:** merchandise (+VAT) + shipping — **does not include cash** |

### New / important fields

| Field | Meaning |
|-------|---------|
| `cashArrangementRequested` | `true` if any line has cash |
| `cashArrangementAmount` | Raw cash to include (never taxed) — e.g. `400` |
| `cashArrangementFeeAmount` | Cash handling **fee** (pre-VAT portion) — e.g. `40` |
| `cashArrangementFeeVatAmount` | VAT on the fee only — e.g. `0` when inclusive / zero rate |
| `cashArrangementDenomination` | Preferred notes (when a single cash line) |
| `cashArrangementNote` | Note (when a single cash line) |
| **`payableTotalAmount`** | **What the order will charge** (= checkout / Apple Pay). Use this in the footer. |

### Your example (UAE, 400 cash gift)

**Before (broken):**
```text
quote.totalAmount = 474
order.totalAmount = 914
```

**After:**
```json
{
  "subtotalAmount": 449,
  "shippingAmount": 25,
  "taxAmount": 0,
  "totalAmount": 474,
  "cashArrangementRequested": true,
  "cashArrangementAmount": 400,
  "cashArrangementFeeAmount": 40,
  "cashArrangementFeeVatAmount": 0,
  "payableTotalAmount": 914,
  "currency": "AED"
}
```

```text
payableTotalAmount = totalAmount + cashArrangementAmount + fee(+ fee VAT)
                   = 474 + 400 + 40
                   = 914   ← same as order.totalAmount
```

### App rule (safe with old backends)

```text
displayTotal = quote.payableTotalAmount ?? quote.totalAmount
```

Deploy is safe before the app update: old apps keep using `totalAmount`; new apps use `payableTotalAmount` when present.

---

## 2. How to send cash on quote

### Signed-in (server cart)

Omit `items` (or send them). Cash is read from cart lines (`cashArrangementAmount` etc. already on the cart).

```http
POST /api/v1/orders/quote
Authorization: Bearer …
X-Region: UAE
Content-Type: application/json

{ "addressId": "…" }
```

### Guests (or explicit items)

Send per-line cash like guest checkout:

```json
{
  "items": [
    {
      "productId": "…",
      "quantity": 1,
      "giftCardSelected": false,
      "cashArrangement": {
        "cashAmount": 400,
        "denomination": 100,
        "note": "Please include notes"
      }
    }
  ],
  "shippingAddress": { "deliveryZoneId": "…" }
}
```

Always send **`X-Region`**.

---

## 3. How to show the price breakdown (required UX)

Show a **clear labeled receipt** so the customer understands how the total is built — same idea as the product page cash box and Order Review.

### Recommended labels (EN)

| Quote / order field | Label on screen |
|---------------------|-----------------|
| Product line(s) / `subtotalAmount` | **Subtotal** (or product name × qty with price) |
| `shippingAmount` | **Shipment** — sublabel: *flat rate and VAT inclusive* |
| `cashArrangementAmount` | **Cash amount for flower arrangement** (or “Cash amount”) |
| `cashArrangementFeeAmount` (+ show fee VAT if you break it out) | **Cash handling service fee** |
| `payableTotalAmount` | **Total** |
| `vatInclusive === true` | Sublabel under total: **VAT Inclusive** |
| `vatInclusive === false` && `taxAmount > 0` | Show a **VAT** / tax row using `taxAmount` |

### Example layout (matches the screens you already have)

```text
ORDER REVIEW
Your order

Large Bouquet … × 1                    359.00
This product will be shipped within one day.

Subtotal                               359.00
Shipment                                25.00
  flat rate and vat inclusive
Cash amount for flower arrangement   5,000.00
Cash handling service fee              525.00
────────────────────────────────────────────
Total                                5,909.00
  VAT Inclusive
```

Rules:

1. Footer / Apple Pay amount = **`payableTotalAmount`**, never legacy `totalAmount` when cash is present.  
2. Hide cash rows when `cashArrangementRequested !== true` (or amounts are null).  
3. Do **not** invent the fee client-side for the final total — trust quote/order.  
4. Raw cash is **not** discounted by promo and **not** taxed; only the **fee** may have VAT.  
5. Free-delivery / min-max still use merchandise net only (cash does not unlock free shipping).

### PDP “Add cash arrangement” box

You can keep a live estimate while the user picks amounts:

```text
Flower price              359.00
Cash amount             5,000.00
Cash handling service fee 525.00
Estimated subtotal (VAT inclusive)  5,884.00
```

Then on bag / checkout, **refresh with `POST /orders/quote`** and drive the footer from `payableTotalAmount` (+ shipping once address/zone is known).

---

## 4. Math reminder (server)

```text
unitPrice     = region product price (+ variant) + gift/name extras
subtotal      = Σ unitPrice × qty
− discount    (promo on merchandise only)
+ merchandise VAT   (exclusive adds; inclusive extracts)
+ shipping          (flat, VAT-inclusive — no extra VAT)
+ cash amount       (passthrough)
+ cash fee          (+ fee VAT if exclusive)
= payableTotalAmount  (= order.totalAmount after checkout)
```

---

## 5. Checklist

- [ ] Use `payableTotalAmount ?? totalAmount` everywhere a payable total is shown (bag, checkout footer, Apple Pay amount source)  
- [ ] Show labeled rows: Subtotal, Shipment, Cash amount, Cash handling service fee, Total  
- [ ] Mark shipping as “flat rate and VAT inclusive” when you show that copy  
- [ ] Show “VAT Inclusive” under total when `vatInclusive === true`  
- [ ] Guests: send `items[].cashArrangement` on quote  
- [ ] Signed-in: ensure cash is saved on the cart line before quoting  
- [ ] After checkout, order `totalAmount` should match the last `payableTotalAmount`

---

Questions: reply with the endpoint + sample body/response.
