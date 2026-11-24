# 5AFFUL pairing site

Links a WhatsApp number to the bot and hands back a session ID. A person can
link **one number** or **two numbers** in the same visit, and leaves with a
ready-to-upload `index.js` that already has the ID(s) inside it.

```
npm install
npm start                 # http://localhost:3000
npm test                  # unit + API tests (node --test)
node tests/e2e.js         # end-to-end over real HTTP, including a real download
node tests/wiring.js      # every element the page script touches exists in the HTML
```

Deployed at `https://fiveafful-pair.onrender.com` (Render, `autoDeploy` from
`main`). `PORT` and `HOST` are read from the environment; the default is
`0.0.0.0:3000`.

## What the bot uses

```
GET /api/session/{ID}
```

That is the only bot-facing route, and it is unchanged: `200` with the creds
object itself for the whole 5-minute life of the ID, `404` after that. See
`PAIR-SITE.md` for the contract in full.

## What the page uses

```
POST /api/pair                     { method: "code"|"qr", number, number2?, devices?: 1|2 }
                                   -> { job, batch, devices }
GET  /api/job/{job}                single-number state (kept for older pages)
GET  /api/batch/{batch}            state, slot, slots[], sessionIds[], idSecondsLeft, bundle
POST /api/batch/{batch}/retry      start only the number that failed
GET  /api/bundle/{batch}/index.js  the bot's index.js with SESSION_IDS filled in
POST /api/cancel/{job|batch}       { ok: true }
GET  /healthz                      { ok: true }
```

### Two numbers

The numbers are paired **sequentially**: slot 0 starts immediately, slot 1
starts the moment slot 0 links. One person, one phone at a time — a pairing code
that sits unused for four minutes is a code that expires.

The session IDs are issued **at the end**, together, so both start a full five
minutes at the same moment. Each slot's ID is *refreshed* rather than re-minted
(`Vault.refresh`), so the ID that was messaged to the person on WhatsApp is the
same one the bundle carries.

A failed number is retried alone (`/retry`), and the number that already linked
keeps its login.

### The download

`GET /api/bundle/{batch}/index.js` answers `200` with

```
Content-Type: text/javascript; charset=utf-8
Content-Disposition: attachment; filename="index.js"
Cache-Control: no-store
```

once every slot is linked, and `404` before that. The body is the bot's own
bootstrap (`lib/template/index.js.tpl`, a verbatim copy of `5AFFUL-V6/index.js`
with one marker line) with the `SESSION_IDS` block filled in — one ID per line,
main bot first. `renderIndex()` refuses to build anything unless the template
contains the marker exactly once and every ID matches
`5AFFUL-[A-HJ-NP-Z2-9]{4}-…`, so a broken template can never ship a file that
silently loses the IDs.

The template also sets, before the bot starts:

```
SAFFUL_PRESERVE_DM_NOTIFICATIONS=true
SAFFUL_PRESENCE_REASSERT_MS=60000
```

so a fresh panel keeps the phone's message notifications working without the
person editing anything.

## Layout

| path | what it is |
|---|---|
| `server.js` | routes, rate limits, static files |
| `lib/vault.js` | session IDs: `put`, `read`, `status`, `refresh`, TTL, `canonical()` |
| `lib/pairing.js` | one pairing job: code or QR, then linked / failed |
| `lib/batch.js` | one visit: 1–2 numbers, sequential slots, IDs at the end |
| `lib/index-template.js` | `renderIndex({ ids })` |
| `lib/template/index.js.tpl` | the bootstrap that gets downloaded |
| `lib/connector.js` | the real WhatsApp side (Baileys) |
| `public/` | the page |

`lib/template/index.js.tpl` is regenerated from `5AFFUL-V6/index.js` whenever
that file changes; the one-off script lives outside this repo
(`%TEMP%/opencode/make-tpl.js`) and asserts every anchor it rewrites is unique.

## Limits

`PAIR_LIMIT` 8 per 10 min per address, `SESSION_LIMIT` 20 per min,
`MAX_JOBS` 40 (jobs + batches). Every JSON answer is `no-store`.
