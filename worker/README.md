# Earth Tracker Worker

The small Cloudflare server behind Earth Tracker. It handles sign-in, and relays the live ship feed to signed-in viewers through a Durable Object called `ShipRelay`. Everything that uses an API quota sits behind sign-in, so nobody can use up your free plans without the password.

Deploying it safely, step by step, is covered in the **Secure Worker deployment runbook** (in the App development project). The short version, in Windows PowerShell from this folder:

```powershell
npx.cmd wrangler@4 login
npx.cmd wrangler@4 secret put SITE_PASSWORD
npx.cmd wrangler@4 secret put TOKEN_SECRET
npx.cmd wrangler@4 secret put AISSTREAM_KEY
npx.cmd wrangler@4 deploy
npx.cmd wrangler@4 logout
```

Use `npx.cmd`, not `npx`: Windows PowerShell blocks `npx` as a script.

## Secrets

| Name | What it is | Where it comes from |
| --- | --- | --- |
| `SITE_PASSWORD` | The shared sign-in password | Your password manager |
| `TOKEN_SECRET` | Signs 30-day sessions; changing it signs everyone out | Generated (see the runbook) |
| `AISSTREAM_KEY` | Live ship data | aisstream.io → API Keys |

Secrets live only in Cloudflare. They're never in this repo, the browser, or chat.

## Endpoints

| Path | Who | What |
| --- | --- | --- |
| `GET /api/health` | Anyone | `{"ok":true}` if the Worker is up |
| `POST /api/session` | Anyone (10 tries/min per IP) | Password → session token |
| `GET /api/me` | Signed in | Is my session still valid? |
| `WS /api/ships` | Signed in, from an allowed site | Live ships in the area you're viewing |

## How the ship relay keeps within the free plan

- One shared connection to aisstream.io for all viewers (aisstream allows 3 per account and no browser connections).
- It only connects while a signed-in viewer has ships switched on, and hangs up 2 minutes after the last one leaves.
- It subscribes only to the areas viewers can currently see, and each viewer only receives ships in their own view.
- On the free plan, going over a daily limit makes requests fail until 00:00 UTC (10am Brisbane); it never charges.

## Testing locally

```sh
node test.mjs                                   # sign-in and relay logic
cd ../tools/mock && npm install && node mock-aisstream.mjs   # fake ship feed (synthetic ships)
```

Then create `worker/.dev.vars` (git-ignored) with test values, including `AIS_URL=ws://127.0.0.1:9001`, and run `npx wrangler@4 dev`.

## Notes

- `ALLOWED_ORIGINS` in `wrangler.toml` lists the sites allowed to call the Worker (also enforced for the ship WebSocket). If the site moves, add the new address there.
- `preview_urls = false` keeps the Worker on one public address. Wrangler warns about it on deploy; that's expected.
