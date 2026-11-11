# Pyfio Router (MCP server)

An MCP server with five tools that answer from the provider a quality judge measured as best, and sign every answer so you can check that it was not changed afterwards.

**Status: a demo (phase 1, version 0.2.0) that runs on your own machine.** There is no hosted endpoint, no account, no price and no sign-up. Nothing is sent to Pyfio or anyone else about your use: the optional anonymous day counts stay in a local folder, because no endpoint is set (`PYFIO_ZAEHLER_URL` is empty; `PYFIO_TELEMETRY=off` or `DO_NOT_TRACK=1` turns even the local counts off). Tool calls go only to the public services each tool names (Nominatim, OSRM, Open-Meteo, the page you read, the search providers whose keys you set). Apache-2.0, by Pyfio UG (haftungsbeschraenkt).

## Tools

| Tool | What it does |
| --- | --- |
| `read_page` | title and main text of a public web page as Markdown (plain fetch, then headless Chromium only when needed) |
| `travel_time` | typical and cautious car minutes for a day and hour in Germany, places geocoded with a confidence; no live traffic |
| `web_search` | Serper/Exa with your own keys; without keys a keyless fallback (Wikipedia, Mwmbl, Stack Exchange, MDN, Hacker News) |
| `weather` | 1 to 7 days, mean of the 3 models with the lowest measured error near the place (Open-Meteo, free API, non-commercial use) |
| `build_or_use` | local, deterministic advice whether to build a capability yourself or call the router, from a measured table |

The advice of `build_or_use` names a free daily quota (50 calls) and a price per call after it; these are placeholder values (settings `router.freiProTag`, `router.preisJe1000Usd`) for a possible future hosted service. There is nothing to buy or pay: running the router yourself is free and no such service exists today.

Every answer names its provider and carries a measured score (`judge`) and the signed `urteil`. The measurements are one period and our own reference: a snapshot, not a guarantee. Details: [REFERENCE.md](REFERENCE.md). `PYFIO_LANG=de` switches to German tool names.

## Install (no npm registry needed)

```
git clone https://github.com/zweice/pyfio-router-mcp.git
cd pyfio-router-mcp
npm ci
claude mcp add pyfio-router -- node "$(pwd)/bin/pyfio-router.mjs"
```

Without a clone, npm can fetch it straight from GitHub: `claude mcp add pyfio-router -- npx -y github:zweice/pyfio-router-mcp` (needs git; installs on first start).

Node 20 or newer. Other clients (Claude Desktop, Cursor): `{ "pyfio-router": { "command": "node", "args": ["/full/path/to/bin/pyfio-router.mjs"] } }`. Try it without a client: `node bin/pyfio-router.mjs call weather '{"place":"Hamburg","days":2}'`.

## Check a signed verdict

```
node bin/pyfio-router.mjs call travel_time '{"from":"Hamburg Hbf","to":"Berlin Hbf"}' > answer.json
node scripts/verify-standalone.mjs answer.json --key-id <key id you expect>
```

`verify-standalone.mjs` is one file that uses only `node:crypto`. Exit code 0 means the Ed25519 signature over the canonical JSON holds. A valid verdict proves the answer was not changed after signing, and, only with the key id pinned, that this installation signed it. It does not prove the content is true. Each installation makes its own key on first use (`<state>/urteil-schluessel.json`); the private key is never logged or returned.

## Tests

`npm test` runs 124 hermetic tests (fake upstreams, injected clock); the browser tests need Chromium. `node scripts/pruefe-text.mjs` checks for control characters and long dashes.

Issues and pull requests are welcome.
