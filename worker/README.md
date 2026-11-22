# Earth Tracker Worker

The small Cloudflare server behind Earth Tracker. Right now it only handles sign-in. In later stages it will also relay the live ship and aircraft feeds and serve the markets panel, all behind that sign-in, so nobody can use up your free API quotas without the password.

## One-time setup (about 5 minutes, on your desktop)

You need Node.js installed. Run these from this `worker` folder:

```sh
npx wrangler login
```

This opens your browser to sign in to Cloudflare. Nothing to copy or paste: no API token to manage.

```sh
npx wrangler secret put SITE_PASSWORD
```

Type the shared password you want to use. Make it long, since it guards your API quotas.

```sh
npx wrangler secret put TOKEN_SECRET
```

Paste any long random string, at least 40 characters (a password manager's generator works well). It signs the 30-day sessions. Changing it later signs everyone out.

```sh
npx wrangler deploy
```

Wrangler prints the Worker's address, something like `https://earth-tracker.<your-subdomain>.workers.dev`. Put that address into `workerUrl` in `site/js/config.js` and push, and the **Sign in** button goes live.

## Checking it works

Open `https://earth-tracker.<your-subdomain>.workers.dev/api/health` in a browser. You should see `{"ok":true}`.

## Notes

- If `wrangler deploy` complains about the `[[ratelimits]]` block, delete that block from `wrangler.toml` and deploy again. Sign-in still works, just without the 10-attempts-per-minute limit.
- `ALLOWED_ORIGINS` in `wrangler.toml` lists the sites allowed to call the Worker. If you move the site (for example to a custom domain), add the new address there.
- Run `node test.mjs` to check the sign-in logic locally.
