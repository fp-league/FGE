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

**4. Create the image store**

```bash
npx wrangler kv namespace create IMAGES_KV
npx wrangler secret put ADMIN_TOKEN    # any long random string
```

Paste the `id` it prints into `wrangler.toml`, replacing
`PASTE_KV_NAMESPACE_ID_HERE`.

(On older wrangler the command is `kv:namespace create` with a colon.)

This is what lets you upload driver photos, team logos and news images.
A JSONBin bin only holds 1MB in total, shared with all the league data, so
images can't live there. KV gives 1GB free and the bin then stores just a
short URL.

KV is used rather than R2 because R2 has to be enabled in the dashboard and
asks for payment details even on its free tier. If you'd rather use R2, the
Worker prefers it whenever it's bound — enable R2, uncomment the
`[[r2_buckets]]` block in `wrangler.toml`, create the bucket and redeploy.
Nothing else changes.

**5. Deploy**

```bash
npx wrangler deploy
```

It prints a URL like `https://fge-api.<your-subdomain>.workers.dev`.

**6. Point the site at it**

In `app.js`:

```js
const API_BASE = 'https://fge-api.your-subdomain.workers.dev';
```

In `manage.html` (near the top of the script block):

```js
const API_BASE    = 'https://fge-api.your-subdomain.workers.dev';
const ADMIN_TOKEN = 'the same string you set as the ADMIN_TOKEN secret';
```

Commit and push. The admin panel's Season tab will then show images as
living in R2 rather than in the bin.

### How images are served

Images are served by the Worker at `/img/<key>`, and every response is put
in Cloudflare's edge cache with a one-year immutable `Cache-Control`. Keys
are random and never reused, so repeat views are served from cache and don't
spend a KV read.

If you later switch to R2 and give the bucket a public `r2.dev` URL or a
custom domain, set `IMAGE_BASE_URL` in `wrangler.toml` to it and redeploy to
bypass the Worker entirely.

### Free tier notes

KV allows 1,000 writes and 100,000 reads per day, and 1GB of storage. An
upload is one write; a cached image view costs no read at all.

## Checking it works

```bash
curl https://fge-api.<your-subdomain>.workers.dev/api/health
# {"ok":true,"now":...}
```

## Discord bot

Slash commands that read the same league record the website does, so the
bot can never disagree with the site. It uses Discord's HTTP interactions,
meaning Discord POSTs commands to this Worker — there is no gateway
connection and nothing running 24/7.

| Command | What it shows |
|---------|---------------|
| `/standings [type] [class]` | Drivers' or constructors' table with gaps |
| `/results [round] [class]` | Classification with DNFs, fastest lap, DOTD and points |
| `/calendar [class]` | Every round, marked completed / next / upcoming |
| `/nextrace [class]` | Next race with a live countdown |
| `/lineups [team] [class]` | Team lineups with numbers and points |
| `/driver <name> [class]` | Points, position, wins, podiums, best finish, form |

Every command defaults to GT3; add `class: GT4` for the other grid.

There are also class-prefixed versions so nobody has to pass `class:` every
time — `/gt4 standings`, `/gt4 results round:8`, `/gt3 calendar` and so on.
Same six views under each, with the class fixed by the command:

```
/gt3 standings | results | calendar | nextrace | lineups | driver
/gt4 standings | results | calendar | nextrace | lineups | driver
```

### Setup

**1. Create the application**

Go to <https://discord.com/developers/applications> and hit *New Application*.

From **General Information** copy the **Application ID** and the **Public Key**.
From **Bot** press *Reset Token* and copy the token — it is shown once.

**2. Give the Worker the public key**

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY    # the Public Key, not the token
npx wrangler deploy
```

The bot token is only needed to register commands from your own machine, so
it never has to go near the Worker.

**3. Point Discord at the Worker**

Back in **General Information**, set **Interactions Endpoint URL** to:

```
https://fge-api.<your-subdomain>.workers.dev/discord/interactions
```

Discord immediately sends a test request and refuses the URL if the
signature check fails, so saving successfully means it is wired up
correctly.

**4. Register the commands**

```powershell
$env:DISCORD_APP_ID="your application id"
$env:DISCORD_TOKEN="your bot token"
node register-commands.mjs YOUR_SERVER_ID
```

Passing your server id makes the commands appear instantly. Leave it off to
register globally, which can take up to an hour.

To find your server id: Discord Settings → Advanced → turn on Developer
Mode, then right-click your server → *Copy Server ID*.

**5. Invite the bot**

**OAuth2 → URL Generator**, tick `bot` and `applications.commands`, then
open the generated URL and add it to your server. The bot needs no
permissions beyond posting, since it only replies to commands.

### Posting results automatically

When you save a result in the admin panel, the Worker can post the
classification straight to a Discord channel.

Create a webhook in Discord (channel settings → Integrations → Webhooks →
New Webhook → Copy Webhook URL), then:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler deploy
```

(Or add it as a secret in the Cloudflare dashboard if wrangler won't log in.)

The admin panel sends only the class and round number. The Worker reads the
result out of the league record itself and builds the embed with the same
code `/results` uses, so the bot can never post a classification that isn't
actually saved, and the post can never disagree with the site.

There's a tickbox next to SAVE RESULTS if you want to save without posting.
`/api/health` reports `announce: true` once the webhook is set.

### Checking it works

`/api/health` reports `discord: true` once the public key is set. In
Discord, type `/standings` — if the commands do not appear, they were
registered globally and have not propagated yet, or the server id was wrong.

## Race control and live timing

One person (the FIA) drives a race from the admin panel's **RACE CONTROL**
tab. What they push appears in two places within a few seconds: a **LIVE
TIMING** page on the site, and an overlay you can drop straight into OBS.

Neither appears when nothing is running — the nav entry and the home-page
strip stay hidden until race control opens a session, and the overlay draws
nothing at all, so it's safe to leave in a scene permanently.

**Deploying without wrangler on your machine**

If `wrangler login` fails ("The Cloudflare OAuth provider returned an error",
"fetch failed"), that's your machine not reaching Cloudflare, not a problem
with the code. You don't have to fix it — GitHub can do the deploy instead.

Add two repository secrets on github.com (Settings → Secrets and variables →
Actions):

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Custom Token. Account-level: Workers Scripts **Edit**, D1 **Edit**, Workers KV Storage **Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages, Account ID in the right-hand column |

From then on every push that touches `worker/` deploys itself. To run a
database migration, go to the **Actions** tab → **Worker** → **Run workflow**
and tick the migration box.

The D1 console in the Cloudflare dashboard (Storage & Databases → D1 → fge →
Console) will also run the migration SQL if you'd rather paste it in by hand.

**One-off setup**

The Worker needs a table for this. Don't re-run `schema.sql` — it drops every
table before rebuilding, which would throw away the votes. Run the migration:

```bash
npx wrangler d1 execute fge --remote --file=./migrations/001-race-control.sql
npx wrangler deploy
```

Then check it took:

```bash
curl https://fge-api.<your-subdomain>.workers.dev/api/live
# {"ok":true,"status":"idle","running":[],...}
```

**Running a race**

1. In **RACE CONTROL**, pick the round and set lights out, then **Load
   session**. That pulls in the grid for the class you're on.
2. Use the flag buttons as the race goes: formation, green, SC, VSC, red,
   chequered. Type into the message box for anything race control wants on
   screen ("Car 44 under investigation").
3. Drag drivers to reorder them, type gaps into each row, and hit OUT when
   somebody retires. Reordering is debounced, so a quick shuffle is one write.
4. **End session** when you're done. That clears everything back to idle and
   the live pages disappear again.

**The OBS overlay**

Add a **Browser** source pointing at:

```
https://fp-league.github.io/FGE/overlay.html
```

Width 1920, height 1080, and leave "Shutdown source when not visible" off so
it keeps polling. The background is transparent, so it composites straight
over the game feed. Two optional parameters:

| Parameter | Default | What it does |
|-----------|---------|--------------|
| `?rows=16` | 12 | How many cars the tower shows |
| `?api=...` | this Worker | Point it at a different Worker |

**Polling cost**

Both the site and the overlay poll `GET /api/live` — about every 3s on the
site and every 1s on the overlay while a session is open, dropping to 60s and
15s when idle. A race with the overlay plus 30 people watching is roughly
20,000 requests across a 90-minute race, well inside the 100,000/day free
tier. An overlay left open overnight on idle costs about 5,800.

## Endpoints

| Method | Path           | Purpose |
|--------|----------------|---------|
| `GET`  | `/api/dotd?class=gt3`    | Vote tallies per race, plus the caller's own votes |
| `POST` | `/api/dotd`              | Cast a vote. `{class, race, driver}` |
| `GET`  | `/api/fantasy?class=gt3` | All entries, for scoring the leaderboard |
| `POST` | `/api/fantasy`           | Submit/update picks. `{class, race, userId, userName, winner, fastest}` |
| `GET`  | `/api/live`              | Current race-control state — the overlay and the site both read this |
| `POST` | `/api/live`              | Admin only. Partial update: send only the fields that changed |
| `POST` | `/api/live/reset`        | Admin only. Ends the session and clears it back to idle |
| `GET`  | `/api/health`            | Liveness |
| `POST` | `/discord/interactions`  | Discord slash commands (signature-verified) |

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
