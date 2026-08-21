# Closers Call Recorder

Records every voice call in your Discord "Closers" channels, on its own, forever.
Nobody has to be online, signed in, or remember to press anything.

When a person joins a watched voice channel, a bot joins beside them and starts
recording. When the last person leaves, it mixes the call down to a single mp3,
optionally transcribes it with speaker names, and files it in Google Drive under
`Discord Recordings/2026-08/`.

---

## How it works

Discord only sends audio while someone is actually talking. A naive recorder
would therefore squash a two-hour call into four minutes of overlapping speech.
This one keeps, per speaker:

- a **condensed** PCM file containing nothing but their speech, and
- a **burst index** saying where in the call each piece of speech belongs.

At the end, the mixer replays those against a real clock through named pipes into
ffmpeg, inserting silence where the index says there was silence. A six-hour call
with two minutes of talking costs about 20 MB of disk instead of 4 GB, and the
speakers still land on the exact second they spoke.

`npm run selftest` proves that: it feeds synthetic speech in at known offsets and
checks it comes back out at those offsets.

Because every speaker has an isolated track, transcripts come out labelled by
name with no diarisation guesswork.

---

## Deploying on Railway

1. Push this folder to a GitHub repo (or use `railway up` from the Railway CLI).
2. **New Project → Deploy from GitHub repo**. Railway reads the `Dockerfile`;
   no build configuration needed.
3. **Settings → Volumes → add a volume mounted at `/data`.** Without it, a call
   in progress is lost whenever Railway restarts the container. 5 GB is plenty
   if `DELETE_LOCAL_AFTER_UPLOAD=true`.
4. **Variables** → paste in the values from `.env.example`. At minimum
   `DISCORD_TOKEN`, `WATCH_CATEGORY_NAMES`, `LOG_CHANNEL_ID`.
5. Deploy, then watch the logs for `logged in as…` followed by
   `watching N voice channel(s)`.

There is no HTTP port. Railway may warn about no public domain — ignore it.

## Google Drive

rclone can't run its browser dance inside a container, so authorise once on your
own machine and paste the result in as a variable.

```bash
# on your PC, with rclone installed (winget install Rclone.Rclone)
rclone authorize "drive"
```

It opens a browser, you approve, and it prints a token block starting with
`{"access_token":`. Copy the **whole thing including the braces** into the
`GDRIVE_TOKEN` variable on Railway, and set:

```
RCLONE_REMOTE=gdrive:Discord Recordings
```

The container assembles the rclone config from that on boot. If the folder
doesn't exist in your Drive, rclone creates it on the first upload.

### Make your own Google client ID (do this now, not later)

By default rclone uses a shared Google client ID that **Google is retiring during
2026** — rclone itself warns about it. Uploads will simply stop one day if you
rely on it. Ten minutes in the Google Cloud console avoids that:

1. console.cloud.google.com → new project → **APIs & Services → Enable APIs** →
   enable **Google Drive API**.
2. **OAuth consent screen** → External → add yourself as a test user.
3. **Credentials → Create credentials → OAuth client ID → Desktop app.**
4. Set `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` on Railway, and run
   `rclone authorize "drive" "<client_id>" "<client_secret>"` to get the token.

Your own client ID is also considerably faster than the shared one, which is
rate-limited across every rclone user on earth.

## Finding your channel and category names

After inviting the bot:

```bash
npm run channels
```

It prints every server, category and voice channel the bot can see, with IDs, and
flags any channel where the bot lacks View or Connect. Use the exact category
name in `WATCH_CATEGORY_NAMES`.

---

## Recording two calls at once

A single bot user can only hold one voice connection per server — that's a
Discord limit, not a limitation of this code. If two Closers channels can be live
at the same time, create a second bot application, invite it too, and set
`DISCORD_TOKEN_2`. Each extra token buys one more simultaneous recording. The
bots coordinate: whichever one is free takes the next call.

If every bot is busy, the notices channel says so rather than silently missing
the call.

---

## Settings worth knowing

| Variable | Default | Effect |
| --- | --- | --- |
| `MIN_HUMANS` | `1` | Records even when one person sits alone. `2` captures only real conversations. |
| `LEAVE_GRACE_SEC` | `20` | Someone can drop and rejoin without splitting the recording in two. |
| `MIN_DURATION_SEC` | `20` | Anything shorter is discarded, so channel-hopping doesn't litter your Drive. |
| `MAX_SESSION_HOURS` | `6` | A marathon call becomes several parts instead of one unusable file. |
| `KEEP_USER_TRACKS` | `false` | Also keep each speaker's isolated mp3, for editing. |
| `DELETE_LOCAL_AFTER_UPLOAD` | `false` | Turn on once you trust the uploads, to keep the volume clear. |
| `RETENTION_DAYS` | `0` | Auto-delete local copies after N days. Zero keeps them forever. |
| `AUDIO_CHANNELS` | `1` | Mono mixdown. `2` for stereo. |

## Transcripts

`TRANSCRIBE=off` by default.

- `TRANSCRIBE=openai` with an `OPENAI_API_KEY` — roughly **$0.36 per hour of
  actual speech** (silence is stripped before it's sent, so an hour-long call
  with twenty minutes of talking costs about twelve cents).
- `TRANSCRIBE=local` runs whisper.cpp on the same container — no API key, no
  per-minute cost, but it needs a bigger Railway instance and a model file
  baked into the image, and a long call can take longer to transcribe than it
  took to record.

Output looks like:

```
[00:04:12] Jack: so where did we land on the pricing question
[00:04:19] Marcus: they want annual, we said quarterly
```

---

## A word about consent

The bot is deliberately conspicuous. It sits in the voice channel member list the
entire time it records and posts a **Recording started** notice every time it
joins. Keep both on.

Recording a conversation without everyone knowing is illegal in a good part of
the country — roughly eleven US states require every party to consent, and the UK
and EU are stricter still. The safe version is easy: tell your closers the
channels are recorded, and put it somewhere they've actually read. Switching off
`ANNOUNCE_START` to record people quietly is not what this is for.

---

## When something's wrong

| Symptom | Fix |
| --- | --- |
| `Discord rejected the bot token` | Regenerate it in the developer portal and update the variable. |
| `DisallowedIntents` | Server Members Intent is still off in the portal's Bot tab. |
| `watching 0 voice channel(s)` | Run `npm run channels`. Is the category name spelled exactly right, and does the bot's role have View + Connect on those channels? |
| Bot joins but the file is silent | The bot has been server-deafened. Undo that in the server's role settings. |
| `rclone remote is not reachable` | `GDRIVE_TOKEN` is missing or expired — re-run `rclone authorize "drive"`. |
| A call stopped halfway through | Look for `voice connection lost` in the logs, usually a network blip. The bot rejoins and opens a new file. |
| Volume filling up | Set `DELETE_LOCAL_AFTER_UPLOAD=true` and `RETENTION_DAYS=14`. |

## Running it locally instead

```bash
npm install
cp .env.example .env   # fill it in
node --env-file=.env index.js
```

Needs Node 20+, ffmpeg and rclone on PATH. The machine has to stay awake — which
is the whole reason to put it on Railway instead.
