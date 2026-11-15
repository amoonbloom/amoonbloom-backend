# App team update — COD status + history payment fields

**Date:** 15 Nov 2026  
**Share this file** with the mobile team (or fold into `APP_DEVELOPER_GUIDE.md`).

Hi team,

Two backend changes that affect how you label orders in the **history list** and after **COD checkout**.

---

## 1. COD orders start as `PROCESSING` (not `PENDING_PAYMENT`)

### Before
Every order (COD and online) was created with:

```json
{ "status": "PENDING_PAYMENT", "paymentMethod": "COD", "paymentStatus": "UNPAID" }
```

The app often showed **“Pending payment”** for COD, which confused customers (nothing to pay online).

### After

| Payment method | `status` at create | `paymentStatus` | Notes |
|----------------|--------------------|-----------------|--------|
| **`COD`** | **`PROCESSING`** | `UNPAID` | Normal — cash collected on delivery. Show **“Processing”** / “Order received”, **not** “Pending payment”. |
| **`MYFATOORAH` / `MOYASAR`** | **`PENDING_PAYMENT`** | `UNPAID` | Waiting for online pay. After success → `PROCESSING` + `paymentStatus: "PAID"`. |

Applies to all create paths: checkout, guest checkout, buy-now, express checkout.

### App rules

1. **Do not** map every `PENDING_PAYMENT` to “Pending payment” without checking `paymentMethod`.  
2. For **COD**, prefer the status label **Processing** (API already returns `PROCESSING`).  
3. For **online unpaid**, show **Pending payment**.  
4. Paid online = `paymentStatus === "PAID"` (unchanged).  
5. Push `ORDER_PLACED` for COD now carries `status: "PROCESSING"` in the data payload.

### Example — COD create response

```json
{
  "success": true,
  "data": {
    "id": "…",
    "orderNumber": 1042,
    "status": "PROCESSING",
    "paymentMethod": "COD",
    "paymentStatus": "UNPAID",
    "totalAmount": 250
  }
}
```

### Example — online create response (unchanged shape)

```json
{
  "success": true,
  "data": {
    "id": "…",
    "status": "PENDING_PAYMENT",
    "paymentMethod": "MYFATOORAH",
    "paymentStatus": "UNPAID"
  }
}
```

---

## 2. `GET /orders/history` now returns `paymentMethod` + `paymentStatus`

You asked for these so the **list** can label COD correctly without opening detail.

Each history row now includes (same idea as admin list / order detail):

```json
{
  "id": "…",
  "orderNumber": 1042,
  "status": "PROCESSING",
  "paymentMethod": "COD",
  "paymentStatus": "UNPAID",
  "totalAmount": 250,
  "currency": "SAR",
  "itemCount": 2,
  "createdAt": "…"
}
```

Fields are always present on new responses. Treat as optional if you need to support older backends briefly.

### Suggested list label logic

```text
if paymentMethod == COD:
  show status label for `status`   // usually "Processing"
else if status == PENDING_PAYMENT and paymentStatus != PAID:
  show "Pending payment"
else:
  show normal status label (Processing / Completed / …)
```

Or simply: **always show the mapped `status` label**, and only use “Pending payment” when `status === PENDING_PAYMENT`. After this backend change, COD never stays in `PENDING_PAYMENT`, so the list stops lying for new COD orders.

---

## 3. Status labels (unchanged enum)

| API `status` | Show as |
|--------------|---------|
| `PENDING_PAYMENT` | Pending payment |
| `PROCESSING` | Processing |
| `ON_HOLD` | On hold |
| `COMPLETED` | Completed |
| `CANCELLED` | Cancelled |
| `REFUNDED` | Refunded |
| `FAILED` | Failed |
| `DRAFT` | Draft |

---

## 4. Checklist

- [ ] After COD checkout, expect `status: "PROCESSING"` (not `PENDING_PAYMENT`)
- [ ] History list: read `paymentMethod` / `paymentStatus` when present
- [ ] Never show “Pending payment” for COD on new orders
- [ ] Online unpaid still uses `PENDING_PAYMENT` until paid
- [ ] Deep links / push: COD `ORDER_PLACED` may include `status: "PROCESSING"`

---

## 5. What we did **not** change

- `paymentStatus` for COD remains `UNPAID` until you/ops mark it paid if you ever do — cash is still due on delivery.
- Online flow still: create → `PENDING_PAYMENT` → pay → `PROCESSING` + `PAID`.
- Order detail (`GET /orders/{id}`) already had these payment fields.

Questions: reply with endpoint + sample body/response.
