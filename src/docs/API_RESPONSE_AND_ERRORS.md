# API response format and error handling

## Response format (all APIs)

- **Success:** `{ success: true, message, data?, meta? }`
  - `message`: string (e.g. "Product created successfully")
  - `data`: optional; omitted when undefined
  - `meta`: optional object (e.g. `{ pagination }`, `{ total }`, `{ count }`)

- **Error:** `{ success: false, message, errors? }`
  - `message`: string
  - `errors`: optional array (e.g. validation `[{ field, message }]`)

Use `success()` and `error()` from `utils/response.js` only. Middleware (errorHandler, validate, auth) use the same helpers.

## Error handling

- **Validation (400):** `handleValidationErrors` → `error(res, 'Validation failed', 400, errors)`
- **Auth (401/403):** `error(res, message, 401|403)`
- **Not found (404):** `error(res, '...', 404)` or global handler for Prisma P2025
- **Conflict (409):** Prisma P2002 → global handler; controllers use `error(res, message, 409)` where needed
- **Server (500):** Global handler → `error(res, message, status, err.errors)`

## Performance

- **List endpoints:** Use `Promise.all([findMany, count])` for paginated lists (products, users, orders, contact messages).
- **Single-record reads:** One `findUnique` with required `include`/`select`; avoid N+1.
- **Auth:** `verifyAdmin` / `verifyInstructorOrAdmin` use `select: { id: true, role: true }` only.
- **Sections/Cart/Order:** Nested `include` for products (images, descriptions) in one query.
