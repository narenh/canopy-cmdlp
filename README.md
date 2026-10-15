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

Deployed on Coolify from the `Dockerfile` in this repo.

**What this isn't.** It doesn't play anything, queue anything, or know who the guests are:
the hubs do all that, and only the hubs talk to it, with one shared token. Guests are trusted
(they're at the party), so there are no per-guest limits. Playing these files in the Canopy
Music app is the app's job, in the CanopyMusic repo.

## The API

`openapi.yaml` is the reference. In short:

| | |
|---|---|
| `POST /resolve` `{url, zone}` | Looks the link up and starts the download. Answers with the track: `id`, `status`, `title`, `artist`, `duration`, `artwork`, and `audioUrl`. |
| `GET /tracks/{id}` | The same, with `status` now `pending`, `ready`, or `failed` (and why). |
| `GET /audio/{id}` | The audio. Answers `Range` requests, so players can seek. |
| `DELETE /zones/{zone}` | Stops the zone's downloads and deletes its audio. |
| `GET /health` | Up, and which yt-dlp versions it has and how the last update went. |

Every request but `/health` sends `Authorization: Bearer <CMDLP_TOKEN>`. The one exception is
`audioUrl`: Sonos fetches a URL with no way to add a header, so each `audioUrl` carries its
own key (`?sig=`, an HMAC of the track's id made with the token). It opens that one file and
nothing else. Changing the token changes every key.

Errors are `{"error": "<a sentence>", "reason": "<snake_case>"}`, as in canopy-events and
canopy-account-service.

The same song pasted twice in a zone is one track, downloaded once, whichever form the link
takes (`youtu.be/...`, `music.youtube.com/...`, or a video opened from a playlist). A link
that's only a playlist, an album, or a set is turned down: send one track.

## How it works

- `server.js` is the HTTP side: the token, the routes, and the error shape.
- `lib/ytdlp.js` is yt-dlp: which copy runs, the updates, the fallbacks, and the list of
  sites it may use.
- `lib/tracks.js` is the tracks: looking a link up, the download queue (two at a time), the
  zone folders, and the sweep.
- `lib/media.js` turns a download into the `.m4a`.
- `lib/run.js` runs a program. Never through a shell: a link is passed as an argument, after
  `--`, so it can't be anything but a link.

Everything is files under `DATA_DIR` (`/app/data` in Docker, a Coolify volume):

```
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
site has (for archive.org, the item's own image).

A lookup takes two or three seconds. The first YouTube one after a restart or an update
takes 20 or so: yt-dlp fetches YouTube's player code and solves its challenge with Deno, then
keeps the answer in `cache/`.

Then the download starts, reusing what `-J` found, so YouTube is only asked once.

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
extractor: it fetches whatever URL it's given, which would let anyone with the token make the
server fetch internal addresses. Any link no extractor on the list takes is a 422,
`unsupported_link`.

### The sweep

Every 15 minutes, tracks resolved more than 24 hours ago are deleted, along with any other
file in a zone folder that has no track (a crash's leftovers). Empty zone folders go too.

## Running it

```bash
npm install
```

```bash
cp .env.example .env
```

Set `CMDLP_TOKEN` (`openssl rand -base64 32`). Locally, without Docker, it needs yt-dlp,
ffmpeg, and Deno on the Mac (`brew install yt-dlp ffmpeg deno`), with `YTDLP_STABLE` pointed
at Homebrew's yt-dlp and updates off, as `.env.example` says. Then:

```bash
node --env-file=.env server.js
```

```bash
npm test
```

The tests run a real server against a fake yt-dlp (`test/fake-yt-dlp.js`), so they need
ffmpeg but not the network.

### In Coolify

Build from the `Dockerfile`. It needs:

- `CMDLP_TOKEN`, the same one the hubs have.
- A volume at `/app/data`. Without one, every restart starts again from the stable yt-dlp,
  and a restart mid-party loses the queue's audio.
- The domain `cmdlp.canopysf.com`, on port 3000, with HTTPS from Coolify's proxy.
  `audioUrl` is built from the address the request came to; set `PUBLIC_URL` if that's ever
  wrong.

The image has a health check on `/health`.

### Trying it

```bash
docker build -t canopy-cmdlp .
```

```bash
docker run --rm -p 3002:3000 -e CMDLP_TOKEN=try-it-out-0123456789 -v cmdlp:/app/data canopy-cmdlp
```

```bash
curl -s -X POST localhost:3002/resolve -H 'Authorization: Bearer try-it-out-0123456789' -H 'content-type: application/json' -d '{"url":"https://soundcloud.com/forss/flickermood","zone":"test"}'
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
