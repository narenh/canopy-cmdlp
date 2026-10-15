# Canopy cmdlp

`cmdlp.canopysf.com`. A small API around [yt-dlp](https://github.com/yt-dlp/yt-dlp) that lets
guests at a Canopy Music party queue tracks from YouTube, SoundCloud, Bandcamp, Mixcloud, and
archive.org: rare recordings, live sets, and whatever else the music services don't carry.

- A guest pastes a link. The hub sends it here, and gets back the title, artist, length, and
  artwork in a few seconds.
- Meanwhile the audio downloads in the background, so it's ready by the time it plays. The hub
  plays it from here, as an `.m4a` that AVPlayer and Sonos both play.
- Each party (a **zone**) has its own cache. When the party ends, the hub deletes the zone and
  its audio goes with it. Anything left after 24 hours is deleted anyway.
- yt-dlp updates itself to the latest nightly build, on start and every day, with no one
  touching it. If a new nightly can't download something, the version before it tries, and
  then the stable release.

- `/` is a page saying what this is. Its gear (upper right) goes to the admin page, where the
  admin makes each hub's API token, signed in with their Canopy Account.

Deployed on Coolify from the `Dockerfile` in this repo.

**What this isn't.** It doesn't play anything, queue anything, or know who the guests are:
the hubs do all that, and only the hubs talk to it, each with its own token. Guests are trusted
(they're at the party), so there are no per-guest limits. Playing these files in the Canopy
Music app is the app's job, in the CanopyMusic repo.

## The API

`openapi.yaml` is the reference. In short:

| | |
|---|---|
| `POST /resolve` `{url, zone}` | Looks the link up and starts the download. Answers with the track: `id`, `status`, `title`, `artist`, `duration`, `artwork`, and `audioUrl`. |
| `GET /tracks/{id}` | The same, with `status` now `pending`, `ready`, or `failed` (and why), and while it's pending, how far the download has got (`stage` and `progress`). |
| `GET /audio/{id}` | The audio. Answers `Range` requests, so players can seek. |
| `DELETE /zones/{zone}` | Stops the zone's downloads and deletes its audio. |
| `GET /health` | Up, and which yt-dlp versions it has and how the last update went. |

Every request but `/health` sends `Authorization: Bearer <token>`, with the hub's own token
from the admin page (below). The one exception is `audioUrl`: Sonos fetches a URL with no way
to add a header, so each `audioUrl` carries its own key (`?sig=`, an HMAC of the track's id).
It opens that one file and nothing else. The HMAC's key is made on the first start and kept on
the volume (`audio-key`), apart from the API tokens, so regenerating a hub's token doesn't
break the queue it already has.

Errors are `{"error": "<a sentence>", "reason": "<snake_case>"}`, as in canopy-events and
canopy-account-service.

The same song pasted twice in a zone is one track, downloaded once, whichever form the link
takes (`youtu.be/...`, `music.youtube.com/...`, or a video opened from a playlist). A link
that's only a playlist, an album, or a set is turned down: send one track.

## How it works

- `server.js` is the HTTP side: checking tokens, the routes, and the error shape.
- `lib/tokens.js` is the API tokens; `lib/admin.js` the admin page, its sign-in, and its
  API; `lib/pages.js` the two pages (with `public/cmdlp.css` and `public/admin.js` inlined).
  `lib/canopy-account.js` asks Canopy Accounts who's signed in, and `lib/domain.js` says
  which pages count as Canopy's.
- `lib/ytdlp.js` is yt-dlp: which copy runs, the updates, the fallbacks, and the list of
  sites it may use.
- `lib/tracks.js` is the tracks: looking a link up, the download queue (two at a time), the
  zone folders, and the sweep.
- `lib/media.js` turns a download into the `.m4a`.
- `lib/run.js` runs a program. Never through a shell: a link is passed as an argument, after
  `--`, so it can't be anything but a link.

Everything is files under `DATA_DIR` (`/app/data` in Docker, a Coolify volume):

```
tokens.json                      the API tokens (hashes, never the tokens)
audio-key                        what audioUrls are signed with
bin/yt-dlp                       the copy that runs, updated to nightly
bin/yt-dlp.prev                  the version before the last update
cache/                           yt-dlp's cache (YouTube's player code) and Deno's
zones/<zone>/<id>.track.json     the track
zones/<zone>/<id>.m4a            its audio
```

There's no database. After a restart, ready tracks are still ready and unfinished downloads
start again.

### Looking a link up

`POST /resolve` runs `yt-dlp -J` on the link, which answers with everything yt-dlp knows
about it. The title is the song's name where the site has one (YouTube Music does), or else
the upload's title. The artist is the artist where the site says, or else whoever uploaded
it (for a Mixcloud set, always the uploader: the DJ). The artwork is the largest JPEG the
site has that really exists (for archive.org, the item's own image). yt-dlp lists YouTube's
`maxresdefault.jpg` without checking it, and older or low-resolution uploads often don't have
one, so the best four are asked for one byte each, all at once (three seconds at most;
usually a tenth or two), and the best that answers with an image wins. `hqdefault.jpg`
always exists on YouTube, so it's the floor there. If nothing answers, it's that floor, or
elsewhere yt-dlp's best. Only https addresses with a host name are asked.

A lookup takes two or three seconds. The first YouTube one after a restart or an update
takes 20 or so: yt-dlp fetches YouTube's player code and solves its challenge with Deno, then
keeps the answer in `cache/`.

Then the download starts, reusing what `-J` found, so YouTube is only asked once.

### Download progress

While a track is `pending`, `GET /tracks/{id}` says where it's up to. `stage` is `queued`
(waiting for one of the two download slots), `downloading`, or `converting` (making the
`.m4a`, a few seconds). While it downloads, `progress` has the bytes so far, the speed, the
time left when yt-dlp can tell, and `percent`.

It comes from yt-dlp itself: it's run with `--progress --newline --progress-template`, which
prints one line per update on stdout (`lib/tracks.js`, `PROGRESS_TEMPLATE`), and each line
updates the track as it arrives. `percent` comes from the exact size when the site gives one
(YouTube does), or else from how many of the stream's pieces are in (SoundCloud's HLS). When
neither is known it's `null`: show progress without a percentage. yt-dlp's own estimate of
the size (`totalBytesEstimate`) is passed along but never turned into a percentage, because
it can be well off. Poll about once a second; it's never saved to disk.

### The audio

yt-dlp is asked for YouTube's format 140 first, which is AAC at 128k, then for the best AAC
anything else has (SoundCloud and Mixcloud usually have it), then for the best audio of any
kind.

Then ffmpeg makes the `.m4a`. AAC (and ALAC) is copied as it is, which is nearly everything
from YouTube, SoundCloud, and Mixcloud. Anything else (MP3 from Bandcamp, Opus, Vorbis, FLAC
from archive.org) is re-encoded to AAC at 256k, because Sonos won't play Opus or Vorbis in an
MP4. Either way the file's index goes at the front (`+faststart`), so playback starts before
the whole file has arrived. The track says which happened (`codec`, `transcoded`).

### Keeping yt-dlp working

The sites change, and yt-dlp's fixes reach the nightly builds first, so:

- The image has the stable release (checked against its published SHA-256). On a new volume
  that copy goes to `bin/yt-dlp`.
- On start, and every 24 hours after, `yt-dlp --update-to nightly`. What was there becomes
  `bin/yt-dlp.prev`. If the new copy won't even run, the old one goes back.
- Every lookup and download tries `bin/yt-dlp`, then `bin/yt-dlp.prev`, then the image's
  stable copy, until one works. A link from a site that isn't allowed isn't retried.
- `GET /health` shows all three versions and the last update.

The standalone yt-dlp build has Python and YouTube's challenge solver (yt-dlp-ejs) inside.
The solver needs a JavaScript runtime: Deno, which the image has and yt-dlp finds by itself.

### Which sites

yt-dlp is told which of its extractors it may use (`--use-extractors`, `EXTRACTORS` in
`lib/ytdlp.js`): YouTube, SoundCloud, Bandcamp, Mixcloud, and archive.org, and their playlist
ones, which turn a video opened from a playlist into just the video. Never the **generic**
extractor: it fetches whatever URL it's given, which would let anyone with a token make the
server fetch internal addresses. Any link no extractor on the list takes is a 422,
`unsupported_link`.

### The sweep

Every 15 minutes, tracks resolved more than 24 hours ago are deleted, along with any other
file in a zone folder that has no track (a crash's leftovers). Empty zone folders go too.

## The admin page

`/admin` (the gear on `/`) is where the admin makes an API token for each hub, with a label
("Living Room iPad"), and regenerates or revokes it. There's one admin: whoever is signed in
with the Canopy Account whose email is `ADMIN_EMAIL`.

- **Tokens** look like `cmdlp_` and 43 more characters. Only each one's SHA-256 is kept, in
  `tokens.json` on the volume, so a token is shown once, when it's made, and never again.
  Lost one? Regenerate it. Regenerating makes a new token under the same label, and the old
  one stops working at once; revoking deletes it, the same. The page shows each token's last
  four characters and when it was last used, so it's clear which is which.
- **Who's signed in** comes from Canopy Accounts, as on canopy-events: the visitor's
  `canopy_session` cookie goes to `GET /api/session` on the account service, with the key of
  a site named **cmdlp** (`lib/canopy-account.js`, adapted from canopy-events'). The one
  change: a session only ever comes from the cookie, because here `Authorization: Bearer` is
  an API token.
- **Who's the admin.** `/api/session` doesn't say who the account service's own admin is, so
  `ADMIN_EMAIL` does. Someone gets in only when the person it returns has that `email`
  (ignoring case) and `emailVerified` is true. For `email` to be there at all, the cmdlp site
  must be granted the **email** field in the account admin's Sites tab (and no other: it
  doesn't need them). Without the grant, the page says so rather than just turning everyone
  away. Unset `ADMIN_EMAIL` means nobody gets in, and the page says that too.
- **Signed out**, `/admin` sends you to Canopy Accounts to sign in and brings you back. **A
  quick account** (email not confirmed) isn't let in; the page links to confirming it.
  Anyone else signed in gets a plain "Not allowed", with a way to sign in as someone else.
- **Test a link.** Paste a link to see what a hub would get: which service it's from, the
  title, artist, length, and art, then the download's progress bar (a sliding one when
  there's no percentage), and "Ready" (with the size, and whether it was copied or
  re-encoded) or "Failed" with the reason. A ready track gets an audio player on its
  `audioUrl`, which seeks through Range requests. Errors (`unsupported_link`, a playlist,
  `blocked`) show as their sentence. It uses the admin page's own endpoints
  (`/admin/api/test`), not an API token, and its tracks go in a zone of their own,
  `admin-test`. **Clear test files** deletes that zone, and the 24-hour sweep gets anything
  left.
- **The Origin check.** The page's changes (`POST` and `DELETE` on `/admin/api`) are
  made with the cookie, so they must carry an `Origin` header for a Canopy page (https on
  `canopysf.com` or a subdomain; `http://localhost` too, outside production), or get 403
  `bad_origin`, the same as the other Canopy sites (see the account service's README, "The
  Origin check").

## Running it

```bash
npm install
```

```bash
cp .env.example .env
```

Locally, without Docker, it needs yt-dlp, ffmpeg, and Deno on the Mac
(`brew install yt-dlp ffmpeg deno`), with `YTDLP_STABLE` pointed at Homebrew's yt-dlp and
updates off, as `.env.example` says. Signing in to `/admin` needs the account service running
too (on :3000, with a "cmdlp" site, as `.env.example` says) and `ADMIN_EMAIL` set. Then:

```bash
node --env-file=.env server.js
```

```bash
npm test
```

The tests run a real server against a fake yt-dlp (`test/fake-yt-dlp.js`) and a fake Canopy
Accounts, so they need ffmpeg but not the network.

### In Coolify

Build from the `Dockerfile`. It needs:

- `CANOPY_ACCOUNT_URL`: `https://account.canopysf.com`.
- `CANOPY_ACCOUNT_KEY`: the key of a site named **cmdlp**, made in the account admin's Sites
  tab, granted the **email** field and no other, with quick (unverified) accounts off.
- `ADMIN_EMAIL`: the admin's Canopy Account email.
- A volume at `/app/data`. It holds the API tokens, so without one every restart loses them,
  starts again from the stable yt-dlp, and loses the queue's audio.
- The domain `cmdlp.canopysf.com`, on port 3000, with HTTPS from Coolify's proxy.
  `audioUrl` is built from the address the request came to; set `PUBLIC_URL` if that's ever
  wrong.

The image has a health check on `/health`. Once it's up, sign in at
`https://cmdlp.canopysf.com/admin` and make a token for each hub.

### Trying it

With a token from the admin page:

```bash
curl -s -X POST https://cmdlp.canopysf.com/resolve -H 'Authorization: Bearer cmdlp_...' -H 'content-type: application/json' -d '{"url":"https://soundcloud.com/forss/flickermood","zone":"test"}'
```

Then `GET /tracks/{id}` until it's `ready`, and open its `audioUrl`.

## When YouTube blocks it

YouTube is the hard one. It blocks requests that look automated, and it's much stricter with
servers in data centers than with home internet. From the Mac this was built on, in October
2026, with the nightly yt-dlp and Deno, YouTube lookups and downloads worked with no cookies
and no PO-token plugin. (A three-month-old stable yt-dlp got `HTTP Error 403` on the same
videos: keeping up to date matters.) A server in a data center may not be so lucky.

When it isn't, a lookup fails with `502 blocked` ("Sign in to confirm you're not a bot"), or
downloads fail with `HTTP Error 403`. In order of effort:

1. **Wait for the nightly.** Most breakages are fixed in yt-dlp within days, and it updates
   itself daily. `GET /health` shows the version.
2. **Cookies.** Export `cookies.txt` from a browser signed in to a throwaway Google account
   (never your own: YouTube can ban accounts used this way), put it on the volume, and set
   `YTDLP_COOKIES=/app/data/cookies.txt`. yt-dlp writes it back as it goes, so it must be
   writable.
3. **A PO-token provider**, such as the bgutil plugin. Not set up here; it would mean
   another container and a yt-dlp plugin in the image.
4. **Run it from a home connection** instead of a data center.

SoundCloud, Bandcamp, Mixcloud, and archive.org all worked from the same connection with
nothing extra.
