# Visual Methods analytics

This folder contains a private analytics pipeline for the Visual Methods site:

- Cloudflare D1 stores long-lived traffic snapshots.
- Cloudflare Workers Cron updates the database.
- A local dashboard reads D1 data through `wrangler dev`.

The public site is not changed by this folder.

## Cron plan

```txt
*/5 * * * *      update today and last 24h path snapshots
10 0 * * *       finalize yesterday's daily path data
30 0 1 * *       finalize last month's monthly summary
```

## D1 database

Created database:

```txt
name: visualmethods_analytics
id:   67fd81f3-62c4-467f-8052-1fef43f57b02
```

Apply the schema locally and remotely:

```sh
npx wrangler d1 execute visualmethods_analytics --config analytics/wrangler.toml --local --file analytics/schema.sql
npx wrangler d1 execute visualmethods_analytics --config analytics/wrangler.toml --remote --file analytics/schema.sql
```

## Local dashboard

```sh
cp analytics/.dev.vars.example analytics/.dev.vars
npx wrangler dev --config analytics/wrangler.toml --local
```

Open the local URL Wrangler prints, usually:

```txt
http://localhost:8787
```

Use **Seed demo data** to verify the dashboard before connecting real Cloudflare Web Analytics credentials.

## Real Cloudflare Web Analytics collection

Set these secrets before deploying the cron Worker:

```sh
npx wrangler secret put CF_API_TOKEN --config analytics/wrangler.toml
npx wrangler secret put CF_WEB_ANALYTICS_SITE_TAG --config analytics/wrangler.toml
```

The account id is already in `.dev.vars.example`:

```txt
CF_ACCOUNT_ID=4f91ca2c7e3dda891b1c6da63383b075
```

`CF_WEB_ANALYTICS_SITE_TAG` is the site tag from the Cloudflare Web Analytics snippet for `visualmethods.pages.dev`.

Current site tag:

```txt
0ff381e051174262961cd74c37eae3ee
```

The token should have Cloudflare Analytics read access. If the GraphQL dataset name or fields change, failed collector runs are stored in `collector_runs` and visible in the dashboard.

## Deploy cron Worker later

The dashboard is private by default:

```toml
DASHBOARD_ENABLED = "false"
workers_dev = false
```

When ready to deploy the scheduled collector:

```sh
npx wrangler deploy --config analytics/wrangler.toml
```

Do not enable a public route for this Worker unless you also set `DASHBOARD_TOKEN` or protect it with Cloudflare Access.
