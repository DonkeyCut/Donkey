# Site firewall

`all-apis.json` limits every method under `/api` to 100 requests per 10 seconds
per IP. `export-list-reads.json` adds a limit of 20 GET requests per 10 seconds
for project export lists. `frontend.json` limits non-API requests to 300 per
10 seconds per IP, excluding `/_next/static/` bundles. It covers page navigation,
server actions, dynamic images, and other asset requests. All rules apply across
this Vercel project's domains and deployments, with every HTTP method covered
by the API or frontend rule. Excess requests receive HTTP 429. Matching paths
share each rule's counter within a Vercel region. People sharing an IP share
the allowance; separate regions have separate counters.

The rules run before authentication, functions, and database access for every
hosted client, including older iOS builds. Auth, webhooks, cron routes, workers,
and MCP are covered too. Callers must handle 429 and back off. Browser-local
and Mac-local APIs stay local. Accepted requests incur normal compute charges;
these per-IP limits do not impose a total spending or concurrency cap.

From `site/`, with the Vercel CLI signed in to the Donkey Cut team:

```sh
npm run firewall:check
npm run firewall:stage
npx --yes vercel@59.26.0 firewall publish --scope donkeycut --project donkey
npm run firewall:check
```

Edit the JSON, stage it, review the printed diff, then publish. Staging updates
existing rules by name and creates missing ones. Checking detects drift
from the published rules. Both commands stop when unpublished changes exist;
Vercel's publish command applies all pending firewall changes.

Firewall changes deploy separately from the site build. Keep credentials in
the Vercel CLI login. The CLI version is pinned in the script. Vercel bills
allowed matching requests at its rate-limiting price. Run
`node --test scripts/firewall.test.mjs` to check route coverage and the staging workflow.

[Vercel firewall CLI](https://vercel.com/docs/cli/firewall)
and [rate-limiting scope and pricing](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
