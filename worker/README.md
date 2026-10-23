# FGE API Worker

Holds the shared state the static site can't: DOTD votes and fantasy entries.

Why this exists: GitHub Pages can only serve files, so anything the browser
writes has to go somewhere the browser doesn't control. Before this, votes were
kept in `localStorage`, which meant every visitor had their own private tally —
the DOTD percentages were computed from your own single vote and always read
100%.

## What it guarantees

- **One vote per person per race.** That's the `PRIMARY KEY (class, race, voter)`
  in D1, so it's enforced by the database on write, not by a check in the
  browser that anyone could skip.
- **No forged votes.** The Worker reads the league data itself (with the
  read-only key, held as a secret) and rejects a vote for a race that hasn't
  run, or for a driver who wasn't in it.
- **Fantasy picks close on time.** A pick is rejected once that race has
  results, so nobody can "predict" a race that's already been scored.
- **No raw IPs stored.** Voters are a salted SHA-256 hash of the IP.
- **No keys in the browser.** The read key and salt are Worker secrets.

## Setup

One-time, from this directory. You need a free Cloudflare account.

```bash
npm install -g wrangler        # or use npx below
npx wrangler login
```

**1. Create the database**

```bash
npx wrangler d1 create fge
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`PASTE_DATABASE_ID_HERE`.

**2. Create the tables**

```bash
npx wrangler d1 execute fge --remote --file=./schema.sql
```

**3. Set the secrets**

```bash
npx wrangler secret put BIN_READ_KEY   # the JSONBin read-only Access Key
npx wrangler secret put VOTE_SALT      # any long random string, e.g. openssl rand -hex 32
```

`VOTE_SALT` can be anything, but don't change it later — it would reset
everyone's "already voted" state.

**4. Deploy**

```bash
npx wrangler deploy
```

It prints a URL like `https://fge-api.<your-subdomain>.workers.dev`.

**5. Point the site at it**

Put that URL in `app.js`:

```js
const API_BASE = 'https://fge-api.your-subdomain.workers.dev';
```

Commit and push. Done.

## Checking it works

```bash
curl https://fge-api.<your-subdomain>.workers.dev/api/health
# {"ok":true,"now":...}
```

## Endpoints

| Method | Path           | Purpose |
|--------|----------------|---------|
| `GET`  | `/api/dotd?class=gt3`    | Vote tallies per race, plus the caller's own votes |
| `POST` | `/api/dotd`              | Cast a vote. `{class, race, driver}` |
| `GET`  | `/api/fantasy?class=gt3` | All entries, for scoring the leaderboard |
| `POST` | `/api/fantasy`           | Submit/update picks. `{class, race, userId, userName, winner, fastest}` |
| `GET`  | `/api/health`            | Liveness |

`POST /api/dotd` returns `counted: false` if that person had already voted —
the vote is not double-counted, and the response still carries the current
tally and their existing pick.

## Cost

Free tier: 100,000 Worker requests/day and 5 million D1 row reads/day. A league
this size will not get close.

## Local development

```bash
npx wrangler dev --remote
```

Add `http://localhost:8788` (or whatever origin you serve the site from) to
`ALLOWED_ORIGINS` in `wrangler.toml` while testing.
