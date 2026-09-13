-- Saudi National Address "short address" code (4 letters + 4 digits, e.g. "JHRC3674")
-- captured at checkout and snapshotted onto the order.
--
-- Nullable by design: orders placed before this field existed have no code, and the
-- "required" rule is enforced at checkout (app level) for NEW orders only. Making the
-- column NOT NULL would break every historical row.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippingShortAddress" TEXT;
