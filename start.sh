#!/bin/sh
set -e

echo "[STARTUP] Running database migrations..."
npx prisma migrate deploy

# Optional: seed only when explicitly enabled (e.g. first deploy). Default off so deploys stay fast and healthchecks are not blocked.
if [ "$RUN_SEED" = "true" ]; then
  echo "[STARTUP] RUN_SEED=true — running prisma/seed.js..."
  node prisma/seed.js
else
  echo "[STARTUP] Skipping seed (set RUN_SEED=true to run prisma/seed.js on startup)."
fi

echo "[STARTUP] Starting Node.js server..."
exec node server.js
