# Pyfio Router: reference

The short version is in [README.md](README.md). This file is the long reference.

Each call goes to the provider a quality judge measured as best, and every answer names that provider and its score.

Status: demo (phase 1), version 0.2.0, runs locally. Nothing is hosted; there is no pricing and no sign-up. Pyfio UG (haftungsbeschraenkt), Germany. License Apache-2.0.

## Tools

Five tools, English names by default; `PYFIO_LANG=de` (or `?lang=de` over HTTP) gives the German names in brackets.

| Tool | Input (required in bold) | What it returns |
| --- | --- | --- |
| `read_page` (`seite_lesen`) | **url**, max_chars | title and main text of a public web page as Markdown. Plain fetch + Trafilatura first; headless Chromium + Readability only when that fails; with your own `JINA_API_KEY` Jina Reader for what is still blocked |
| `travel_time` (`fahrzeit`) | **from**, **to**, depart_at, arrive_by | typical and cautious minutes by car for the day and time (Berlin time, German public holidays), both places geocoded with a confidence, distance, an OpenStreetMap link. No account needed: Nominatim/Photon for places, OSRM/Valhalla for the route. There is no default start: `from` is mandatory |
| `web_search` (`websuche`) | **query**, max_results, fresh (day/week/month/year), deeper | results with title, URL, snippet, source. With the operator's `SERPER_API_KEY` and/or `EXA_API_KEY` a cascade (Serper first, Exa when the snippets are weak or `deeper: true`); without a key a keyless fallback (Wikipedia, Mwmbl, Stack Exchange, MDN, Hacker News by kind of question). No provider reachable: an error that names the two variables to set |
| `weather` (`wetter`) | place or lat/lon, days | 1 to 7 days, mean of the 3 models with the lowest measured error near the place |
| `build_or_use` (`bauen_oder_nutzen`) | **task**, **budget_usd**, privacy (local/EU/any), deadline_s | the advice whether to build the capability yourself or use the router: `empfehlung` (`nutzen`, `bauen` or `gratis`), `kategorie`, `selbstbau` and `nutzung` with measured cost, time and quality, `aufruf` (the call to make), `begruendung` from fixed text blocks |

`build_or_use` is local and deterministic: a keyword assignment of the task to `seite_lesen`, `fahrzeit`, `websuche`, `datum` or `unbekannt` (no model, no network), then rules for unknown tasks, privacy, budget and deadline, then the measurement table `data/messungen.json` (stand 2026-10-30; one measured run each, so a snapshot, not a guarantee). The weather tool is not a category of it. The counters see only the category, the budget level, the recommendation, ok, and "asked but no offer", never the task text.

Every answer carries `provider`, `route` or `used` (the steps tried), `judge` and the signed `urteil`.

- `read_page`: `judge.measured` is the token F1 that provider reached on such pages, with sample size; `judge.live` is a check of this one answer, labelled as a heuristic.
- `travel_time`: `judge.measured` is the mean error in minutes against 23 reference values (2.1 min, 2026-10-14); `traffic.live` is always false, the time is typical for the day and hour, not live traffic.
- `web_search`: `judge` says how strong the snippets match the query; `cost_usd` is the operator's cost of this search.
- `weather`: `judge.place_ranking` and per variable the models used and the measured gain.

## The signed verdict (urteil)

Every tool answer carries a field `urteil`: an Ed25519 signature (node:crypto only) over the canonical JSON (RFC 8785 subset: sorted keys, no white space, ECMAScript number and string forms) of this record:

| Field | Meaning |
| --- | --- |
| `v`, `alg` | `1`, `Ed25519` |
| `aussteller` | `pyfio-router/<version>` |
| `werkzeug`, `werkzeug_version` | canonical tool name; 16 hex of sha-256 over name, description and input schema of the English definition |
| `eingabe_sha256`, `ergebnis_sha256` | sha-256 of the canonical JSON of the arguments, and of the answer without `urteil` |
| `pruefungen` | list of `{name, ok}`: `eingabe_schema`, `pflichtfelder`, `zeitlimit`, `quelle_erlaubt`, `groesse` |
| `ergebnis` | `bestanden`, `nicht_bestanden` or `fehler` |
| `zeit` | ISO time of signing |
| `schluessel_id`, `oeffentlicher_schluessel` | first 32 hex of sha-256 of the public key; the raw 32-byte public key, base64url |
| `signatur` | the signature, base64url |

The key pair is made per installation on first use and kept in `<state>/urteil-schluessel.json` (owner-only file; path with `PYFIO_URTEIL_KEY_FILE`); the private key is never logged or returned. In HTTP mode the public key is at `GET /.well-known/pyfio-urteil.json`.

Check an answer:

```
node bin/pyfio-router.mjs call travel_time '{"from":"Hamburg Hbf","to":"Berlin Hbf"}' > antwort.json
node bin/pyfio-router.mjs pruefen antwort.json --schluessel-id <the id you expect>
node scripts/verify-standalone.mjs antwort.json --key-id <the id you expect>   # one file, only node:crypto
```

From code: `verifyUrteil(antwort, { erwarteteSchluesselId })` (module `src/urteil/urteil.mjs`) returns `{ ok, grund }`. Exit code 0 of the two commands means it holds. What a valid verdict proves: the answer was not changed after signing, and (only with the pinned key id) that this installation signed it. Without the pinned id a forger can sign with a key of their own, so pin the id you got from the operator. It does not prove that the content is true; `pruefungen` says what was checked, not that the provider is right.

## Measured (October 2026)

- Pages: 563 URLs (500 Tranco home pages, 63 panel pages), 253 scorable cases, reference = own browser rendering without boilerplate, metric token F1. Cascade 0.62 against 0.57 for the best single reader (+9 %) at 62 % lower compute; browser needed in 31 %. Without Python (Readability on the fetched HTML as stage 1): 0.542 against 0.567, cascade 0.586 (re-measured 2026-10-20, `richter/messung-js/ERGEBNIS.md`).
- Weather: 64 stations (48 METAR, 16 DWD; the published table holds 63 station rows), 11 models via the Open-Meteo Previous Runs API, 2026-07-01 to 10-12. Rolling router (each day the top 3 of the previous 30 days, scored on that day, 08-01 to 10-12): temperature 13.6 to 14.4 %, wind 14.6 to 16.1 % lower error than the best fixed model in hindsight; 18 to 23 % lower than Open-Meteo's default `best_match`. Precipitation yes/no gains little per station, so it is ranked per region.

One period, our own reference: a snapshot, not a guarantee.

## Run it

```
npm install
node bin/pyfio-router.mjs status                     # which readers run here
node bin/pyfio-router.mjs call weather '{"place":"Hamburg","days":2}'
node bin/pyfio-router.mjs call read_page '{"url":"https://en.wikipedia.org/wiki/Hamburg"}'
node bin/pyfio-router.mjs call travel_time '{"from":"Hamburg Hbf","to":"Berlin Hbf"}'
node bin/pyfio-router.mjs call web_search '{"query":"how does an Ed25519 signature work"}'
node bin/pyfio-router.mjs call build_or_use '{"task":"I need the travel time Hamburg to Berlin","budget_usd":0.5}'
```

As an MCP server (stdio), e.g. Claude Code:

```
claude mcp add pyfio-router -- node /path/to/pyfio-router/bin/pyfio-router.mjs
```

Claude Desktop, Cursor and others (`mcpServers` JSON):

```json
{ "pyfio-router": { "command": "node", "args": ["/path/to/pyfio-router/bin/pyfio-router.mjs"], "env": { "PYFIO_LANG": "en" } } }
```

Try it with plain JSON-RPC over stdio (initialize, then one call; the answer is in `result.content[0].text` and carries the `urteil`):

```
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"try","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build_or_use","arguments":{"task":"Read the text of a web page","budget_usd":0.5}}}' \
 | node /path/to/pyfio-router/bin/pyfio-router.mjs
```

Over HTTP: `node bin/pyfio-router.mjs --http --port 8787`, then `POST http://127.0.0.1:8787/mcp` with the same `tools/call` body and the headers `content-type: application/json` and `accept: application/json, text/event-stream` (the server is stateless).

Optional, for the measured best stage 1 and the browser stage:

```
python3.12 -m venv py/venv && py/venv/bin/python -I -m pip install --only-binary=:all: -r py/requirements.txt
npx playwright-core install chromium
```

Without Python, stage 1 is Readability on the fetched HTML; without Chromium, the cascade has one stage.

## Configuration (environment, all optional)

| Variable | Meaning |
| --- | --- |
| `PYFIO_LANG` | `en` (default: `read_page`, `weather`) or `de` (`seite_lesen`, `wetter`) |
| `PYFIO_PYTHON` | a Python with trafilatura; else `py/venv`, else `python3`/`python` on PATH |
| `JINA_API_KEY` | your own key: enables Jina Reader as the last stage (local mode only) |
| `OPEN_METEO_API_KEY` | your own commercial Open-Meteo key (customer API); without it the free API, which Open-Meteo allows for non-commercial use only |
| `PYFIO_STATE_DIR` | state folder (default `%LOCALAPPDATA%\pyfio-router`, `~/.local/state/pyfio-router`) |
| `PYFIO_TELEMETRY`, `DO_NOT_TRACK` | `off` / `1` turn the anonymous daily counts off |
| `SERPER_API_KEY`, `EXA_API_KEY` | the operator's own keys for `web_search`; without them the keyless fallback answers |
| `PYFIO_URL_<NAME>` | replaces a base URL: NOMINATIM, PHOTON, OPEN_METEO_GEOCODING, OSRM, VALHALLA, OSRM_DEMO, SERPER, EXA, WIKIPEDIA, MWMBL, STACKEXCHANGE, MDN, HN (a self-hosted Nominatim or OSRM) |
| `PYFIO_RATE_LIMIT` | `off` removes the pause of at least 1.1 s between requests to the public Nominatim and routing servers (only for servers of your own) |
| `PYFIO_CACHE` | `off` turns off the caches in `<state>/cache` (places 30 days, routes 7 days, the keyless search a few hours; positions are never cached) |
| `PYFIO_USER_AGENT` | your own User-Agent for the public services (the default names the router and its version) |
| `PYFIO_URTEIL_KEY_FILE` | where the signing key of this installation is kept (default `<state>/urteil-schluessel.json`) |
| `PYFIO_ZAEHLER_URL` | where a local install would send its counts; empty (the default and the only setting this repository uses), so nothing is ever sent |

Keys are read from the environment only and never logged, stored or returned. The public Nominatim and routing servers ask for at most one request per second and an identifying User-Agent; the router keeps to that (an in-process gate, so several processes at once are not coordinated). A `travel_time` call sends the two places to those services; with `PYFIO_URL_*` they go to your own.

## Settings (admin menu)

Values that are a matter of balance are not hard-coded: each has a default, a unit and a range, can be changed in `/admin` (hosted mode) and is stored once for all users in `<state>/einstellungen.json`. New in this version:

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `router.freiProTag` | 50 calls | 0 to 100000 | free calls per day named in the advice (a placeholder of the demo; this local install charges nothing) |
| `router.preisJe1000Usd` | 2 USD | 0 to 1000 | price per 1,000 calls named in the advice (a placeholder, not an offer) |
| `router.stufe1Usd`, `stufe2Usd`, `stufe3Usd` | 0.01, 0.1, 1 USD | 0.0001 to 1000 | limits of the budget levels |
| `router.zuordnungMinPunkte`, `zuordnungAbstand` | 2, 1 points | 1 to 10, 0 to 10 | minimum score and lead for a category |
| `fahrzeit.nominatimAbstandMs`, `routerAbstandMs` | 1100 ms | 1000 to 10000 | pause between requests to the public servers |
| `fahrzeit.geoCacheTage`, `routeCacheTage` | 30, 7 days | 0 to 365, 0 to 90 | cache life of places and routes |
| `fahrzeit.diensteZeitlimitMs` | 12000 ms | 2000 to 30000 | time limit per geo or route service |
| `suche.serperProTag`, `exaProTag` | 100, 50 searches | 0 to 100000 | the operator's daily limit per provider (protects the key) |
| `suche.schwacheSchwelle` | 0.35 | 0 to 1 | below this match score the next provider is asked |
| `suche.fallback` | 1 | 0 or 1 | keyless fallback on or off |
| `suche.standardTreffer`, `zeitlimitMs` | 8 results, 15000 ms | 1 to 20, 2000 to 40000 | default result count, time limit |
| `urteil.maxAntwortZeichen` | 200000 characters | 1000 to 5000000 | size limit checked in the verdict (`groesse`) |

## Privacy: what is counted

Per call: day (UTC), tool, ok or error kind, provider, for `build_or_use` only the category, budget level, recommendation, ok and "asked but no offer", client name from the MCP handshake (e.g. `claude-code`), duration bucket, and a pseudonym of the operator. Never: the task text, search queries, URLs, places, page text, forecasts, IP addresses, keys. Pseudonym: locally a random install id, hashed; hosted an HMAC of the IP (IPv6 by its /64) with a server secret renewed every 90 days. Page text is never stored or cached; the per-domain memory keeps keyed hashes of host names only. Files: `<state>/zaehler/<day>/<process>.json`.

## Hosted mode (code only, not deployed)

The HTTP server (`node bin/pyfio-router.mjs --http --port 8787`) is part of the code and is covered by tests, but Pyfio does not run one for anyone, and this repository contains no pricing page, no terms and no sign-up. Anyone can run it for themselves:

| Path | |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP, stateless, JSON responses. `?lang=de` for German tools |
| `GET /health` | version, readers |
| `GET /.well-known/pyfio-urteil.json` | the public key of this installation (for the signed verdict) |
| `POST /v1/zaehler`, `POST /v1/interesse` | counter endpoints for an operator who wants them (see Privacy); unused here |
| `GET /admin` | admin menu: every tunable value with default, unit, range and reset, saved once for all users (`<state>/einstellungen.json`); needs `PYFIO_ADMIN_TOKEN` (16+ characters) |

Behind a proxy: `PYFIO_TRUST_PROXY=1` and `PYFIO_ALLOWED_HOSTS=<your host>`. `PYFIO_HTTP_MCP=off` serves everything except `/mcp`. At most one `tools/call` per request (`http.maxAufrufeJeAnfrage`), 2 browsers and 4 Python processes at once (`lesen.maxBrowser`, `lesen.maxPython`). When fetching for third parties the router follows robots.txt (token `PyfioRouter`, RFC 9309) and the TDM reservation, and sends an honest User-Agent; a foreign `Origin` is refused. Weather in a hosted mode needs your own commercial Open-Meteo key.

## The judge

- `src/richter/seite-messung.json`: the page measurement (per provider and page class).
- `src/richter/wetter-tabelle.json`: per station x variable x lead the model ranking of the last 30 days and the rolling out-of-sample score; built by `richter/build_wetter_tabelle.py` from the cases of the weather measurement.
- Continuous re-measurement (daily forecasts and observations, a sample of page calls against a reference) is the next step and needs a scheduled job.

Source paths named in `data/messungen.json` and `src/richter/*.json` (reports, raw data) point to Pyfio-internal working files that are not part of this repository; the numbers are copied from them.

## Development

```
npm test                      # 124 tests, hermetic (fake upstreams, injected clock); the browser tests need Chromium
node scripts/pruefe-text.mjs  # no control characters, no long dashes
```

Layout: `bin/` CLI, `src/server.mjs` MCP server, `src/tools.mjs` tools, `src/lesen/` page reading (guard, stages, browser process, cascade, robots), `src/wetter/` weather, `src/fahrzeit/`, `src/suche/`, `src/router/` the advice, `src/urteil/` canonical JSON, keys, signing and checking, `src/http.mjs` HTTP mode, `src/zaehler.mjs` counters, `data/` the measurement table and the traffic profile, `scripts/verify-standalone.mjs` the checker without Pyfio code.
