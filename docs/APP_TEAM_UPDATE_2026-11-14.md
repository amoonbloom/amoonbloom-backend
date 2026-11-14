# App team update — 14 Nov 2026

Hi team,

Please use this file as the **only** handoff for this backend release:

**[`APP_DEVELOPER_GUIDE.md`](./APP_DEVELOPER_GUIDE.md)**

It covers what shipped, what you must change in the app, and answers to the earlier backend Q&A.

---

## What you need to implement

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

---

## Headers reminder

| Header | Use |
|--------|-----|
| `Authorization: Bearer …` | Logged-in calls |
| `X-Region: UAE` or `SA` | Catalogue, product, cart, wishlist, quote, checkout |
| `X-Zone: <English zone name>` | Zone-aware catalogue |
| `X-Guest-Token: <uuid>` | Guest wishlist + claim on login |

---

Full endpoints, payloads, and checklist are in **`APP_DEVELOPER_GUIDE.md`**. Reply with the endpoint + sample body/response if anything is unclear.
