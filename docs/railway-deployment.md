# Railway deployment

## Required variables

Set these in the Railway service **Variables** tab:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Use the variable **from your Railway Postgres** plugin (reference `${{Postgres.DATABASE_URL}}` or paste the connection string). |
| `JWT_SECRET` | Long random string (production). Without it, the app exits on startup in `NODE_ENV=production`. |

Railway injects **`PORT`** automatically. The server listens on `process.env.PORT` and binds to `0.0.0.0`.

## Healthcheck

The deploy healthcheck uses **`GET /`**, which returns JSON with `"status": "healthy"`.

## Startup sequence (`start.sh`)

1. `npx prisma migrate deploy`
2. Optional: `node prisma/seed.js` only if **`RUN_SEED=true`**
3. `node server.js`

Seeding is **off by default** so deploys start faster and are less likely to fail before the server listens. For a **first** environment, enable seed once:

- Add variable `RUN_SEED=true`, deploy, confirm admin user exists, then remove `RUN_SEED` or set it to `false`.

Or run seed manually: `railway run npm run seed` (or a one-off job).

## If the healthcheck still fails

1. Open **Deploy logs** and confirm you see `[STARTUP] Starting Node.js server...` and `[SERVER] Server running on port ...`.
2. If the process exits earlier, check **migrate** errors (database URL, network) or missing **`JWT_SECRET`**.
3. Do **not** set `internalPort` in `railway.toml` to a value that disagrees with Railway’s **`PORT`** (see repo `railway.toml` comments).
