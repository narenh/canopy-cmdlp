# Canopy cmdlp

`cmdlp.canopysf.com`. A small API around [yt-dlp](https://github.com/yt-dlp/yt-dlp) that lets
guests at a Canopy Music party queue tracks from YouTube, SoundCloud, Bandcamp, Mixcloud,
archive.org, and most other sites yt-dlp knows: rare recordings, live sets, and whatever else
the music services don't carry.

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
takes (`youtu.be/...`, `music.youtube.com/...`, a video opened from a playlist, or a
SoundCloud short link, which is followed here since yt-dlp can't). Pasted
again, a link the zone already has answers at once (see "Looking a link up"). A link that's
only a playlist, an album, or a set is turned down: send one track.

## How it works

- `server.js` is the HTTP side: checking tokens, the routes, and the error shape.
- `lib/tokens.js` is the API tokens; `lib/admin.js` the admin page, its sign-in, and its
  API; `lib/pages.js` the two pages (with `public/cmdlp.css` and `public/admin.js` inlined).
  `lib/canopy-account.js` asks Canopy Accounts who's signed in, and `lib/domain.js` says
  which pages count as Canopy's.
- `lib/ytdlp.js` is yt-dlp: which copy runs, the updates, the fallbacks, and the extractors
  it may not use.
- `lib/tracks.js` is the tracks: looking a link up, the download queue (two at a time), the
  zone folders, and the sweep.
- `lib/shortlinks.js` follows short links (`on.soundcloud.com`), and `lib/safe-fetch.js` is
  how this server asks another one for anything itself (short links, artwork checks): https,
  public addresses only, headers only.
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
zones/<zone>/<id>.track.json     the track, and the links that led to it
zones/<zone>/<id>.m4a            its audio
```

There's no database. After a restart, ready tracks are still ready and unfinished downloads
start again.

### Looking a link up

First, `POST /resolve` checks whether the link is already a track in the zone, pending or
ready. If it is, that track is the answer at once, with no yt-dlp at all:

- **A YouTube link** is known by its video id, whatever its form: `youtu.be/<id>`,
  `watch?v=<id>` (on `www.`, `m.`, or `music.youtube.com`), `/shorts/<id>`, `/live/<id>`, or
  `/embed/<id>`. A track's id is a hash of its zone, yt-dlp's extractor (`Youtube` for every
  YouTube video), and the video id, so the id can be worked out from the link alone. Once a
  video is in the zone, any link to it is instant, even a form not pasted before.
- **Any other link** is looked up among the links that led to the zone's tracks before. Each
  track keeps those (`aliases`, in its `.track.json`): the link it was first resolved from,
  every other link yt-dlp later said was the same track (`m.soundcloud.com`, say), and every
  short link that led to it (below).
  Links are compared without what only says who shared them: the host's case, the
  `#fragment`, a trailing slash, and tracking parameters (`si`, `is`, `feature`, `pp`, `t`,
  `utm_*`, `fbclid`, `gclid`, `igshid`, and the like) don't count. What says which track it
  is, like YouTube's `v`, does.

A `failed` track is never the answer: it's looked up and downloaded again. The links are kept
in memory too, read back from the `.track.json` files on start, so checking them never reads a
file. They're per zone, like the tracks, and go with them (the zone's deletion or the sweep).
The same song in another zone is looked up and downloaded again: zones share nothing.

A link with a user name in it (`https://soundcloud.com@somewhere.example/`) is a 400
`bad_url`.

**Short links.** yt-dlp has no extractor for `on.soundcloud.com/<code>`: only generic would
follow its redirect, and generic is never on (see "Which sites"). So this server follows it
first, for the hosts on `SHORTENERS` in `lib/shortlinks.js` (only `on.soundcloud.com` so far),
each with the hosts it may lead to (`soundcloud.com`, `www.soundcloud.com`, and
`m.soundcloud.com`):

- Each hop is a HEAD. When HEAD isn't answered properly (anything but a redirect, a 2xx, or a
  404 or 410: a 405, say), it's asked again with a GET, whose body is never read.
- https only: a pasted `http://` short link is asked over https, and a redirect to `http://`
  is refused. At most 5 hops, and 5 seconds for the whole chain.
- Each redirect must lead to another shortener on the list, or to one of the first one's
  hosts. Anything else is refused: `on.soundcloud.com` may only lead to SoundCloud. Where it
  leads is never asked here; that's yt-dlp's to look up, as for any pasted link.
- Every request goes through `lib/safe-fetch.js`, which only connects to a host name (never an
  address) whose addresses are all public. A hop at a private, loopback, link-local, or
  otherwise non-public address (10.x, 127.x, 169.254.x, `::1`, `fd00::/8`, and the rest; the
  list is in the file) is refused before anything connects. The check is in the connection's
  own DNS lookup, so the address checked is the address connected to: a name can't answer
  "public" to the check and "internal" to the connection (DNS rebinding). The connected
  address is checked again before the request goes out.
- The link it leads to goes to yt-dlp without its tracking parameters and fragment (the same
  ones aliases ignore, above; SoundCloud adds `si` and `utm_*`). The track keeps both links as
  aliases, so the same short link pasted again is instant, with no request at all. If where it
  leads is already a track in the zone, the short link is added to that track's aliases, and
  yt-dlp isn't run.

A short link that leads somewhere it may not, over http, more than 5 times, to an address
that isn't public, or nowhere (a 404) is a 422 `unsupported_link`, with a sentence saying
which. A shortener that can't be reached, or answers with an error, is a 502
`lookup_failed`; one that takes more than 5 seconds is a 504 `timeout`.

Otherwise, `POST /resolve` runs `yt-dlp -J` on the link, which answers with everything
yt-dlp knows about it. yt-dlp gets the link as Node's `URL` writes it, which always puts a `/`
after the host: `https://a.example?.soundcloud.com/x` goes to yt-dlp as
`https://a.example/?.soundcloud.com/x`, so an extractor's pattern can't take what's after
the `?` (or a `#`) for the host. If yt-dlp's answer is a track the zone already has, the link
is added to its aliases and the track is the answer, as above. The title is the song's name where the site has one (YouTube Music does), or else
the upload's title. The artist is the artist where the site says, or else whoever uploaded
it (for a Mixcloud set, always the uploader: the DJ). The artwork is the largest JPEG the
site has that really exists (for archive.org, the item's own image). yt-dlp lists YouTube's
`maxresdefault.jpg` without checking it, and older or low-resolution uploads often don't have
one, so the best four are asked for one byte each, all at once (three seconds at most;
usually a tenth or two), and the best that answers with an image wins. `hqdefault.jpg`
always exists on YouTube, so it's the floor there. If nothing answers, it's that floor, or
elsewhere yt-dlp's best. Only https addresses with a host name are asked, through
`lib/safe-fetch.js` as for short links: a thumbnail whose host resolves to a private,
loopback, or link-local address is never fetched, whichever site it came from.

A SoundCloud track with no art of its own shows its uploader's avatar, as on SoundCloud.
When the uploader has none either (SoundCloud's grey default avatar), or nothing loads, it
gets the SoundCloud logo instead: `public/artwork/soundcloud.jpg`, served from
`/artwork/soundcloud.jpg` with no token, since Sonos and the hubs fetch artwork without one.
It's 1500×1500, square on purpose (the Canopy Music clients round artwork themselves),
rendered from `public/artwork/soundcloud.svg`: SoundCloud's current 7-bar cloud, the vector
from soundcloud.com's own web app (its media kit only has small WebPs), in white at 69% of
the width, a little above center, on a gradient from #FF7700 to #FF3000. Only the JPEG is
served.
The other sites have no fallback image yet.

A lookup with yt-dlp takes two or three seconds. The first YouTube one after a restart or an update
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
  stable copy, until one works. A link no extractor takes isn't retried.
- `GET /health` shows all three versions and the last update.

The standalone yt-dlp build has Python and YouTube's challenge solver (yt-dlp-ejs) inside.
The solver needs a JavaScript runtime: Deno, which the image has and yt-dlp finds by itself.

### Which sites

Any site yt-dlp has an extractor for, but a few. yt-dlp is run with

```
--use-extractors default,-generic,-mediasite.*,-globoarticle,-ign\.com,-ignvideo,-ignarticle,-lemonde,-playtvak,-rts,-webcamerapl,-radio\.de,-senate\.gov
```

(`EXTRACTORS` in `lib/ytdlp.js`). `default` is every extractor yt-dlp has on by default, and
each `-<name>` takes one back out (a regex, matched against the whole name, ignoring case).
They're applied in order, and nothing after `default` adds, so nothing can bring an excluded
one back. Whether a site then works is up to its extractor. A link no extractor takes is a
422 `unsupported_link` (yt-dlp says "No suitable extractor found"); one whose extractor fails
is a 502, like any other.

A link that's only a playlist, an album, a set, or a page of several videos, on any site, is a
422 `playlist` (yt-dlp's `_type` is `playlist` or `multi_video`). A live stream, or one that
hasn't started, is a 422 `live`. A video opened from a playlist is just the video
(`--no-playlist`).

**Left out, and why.** The **generic** extractor, always: it fetches whatever URL it's given
and looks for media in it, which would let anyone with a token make the server fetch internal
addresses (Coolify's other services, the cloud's metadata at 169.254.169.254). `default`
includes it, so it has to be taken out by name. The rest take links on hosts that aren't
their site's, and fetch the link as given, so they'd do the same. They were found by trying
every enabled extractor's own test links (yt-dlp 2026.07.04) on a made-up host and on private
addresses, with the real host moved into another host's path, query, or fragment, and with
another domain added to the end of the real host:

| Left out | Its pattern takes |
|---|---|
| `mediasite.*` (Mediasite, MediasiteCatalog, MediasiteNamedCatalog) | Any host with a `/Mediasite/` path. |
| `globoarticle`, `ign\.com`, `ignvideo`, `ignarticle`, `lemonde`, `playtvak`, `rts` | A `.+?` before the domain, which can run past a `/`: `https?://.+?\.ign\.com/` takes `https://anywhere.example/x.ign.com/...`. |
| `webcamerapl`, `radio\.de`, `senate\.gov` | Nothing after the domain, so it can be the start of another: `x.webcamera.pl.anywhere.example`. |

Some others matched those tries too, but stay: they never fetch the link's own host.
StreetVoice, RoosterTeeth, uol.com.br, brightcove:legacy, and simplecast:podcast build their
own API's address from the id in the link. KnownDRM, KnownPiracy, and KnownLiability only say
the site isn't supported. The extractors whose host pattern stops at a `/` can't be fooled by
a site's name after a `?` or `#`, because yt-dlp gets the link with a `/` after the host
(see "Looking a link up"). And yt-dlp's embed search (`_extract_generic_embeds`), which loads
generic even when it's left out, is only called by QuotedHTML, which only ever runs from
inside generic.

**What's still possible.** That check was of yt-dlp 2026.07.04, and the nightly adds
extractors: one added later that takes any host would be on until it's added here (look for
`_VALID_URL`s that don't pin the host, and try the new ones' test links on another host).
Extractors also fetch whatever a site's own pages and APIs point to (an embed, a media
file), and follow redirects, so a site that lets uploaders link anywhere could still lead
yt-dlp somewhere unexpected. The backstop for both is the network: the container shouldn't be
able to reach anything internal.

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
Accounts, so they need ffmpeg but not the network. The fake picks an extractor by host and
honors `--use-extractors` as yt-dlp does, generic included, so a test can show generic is
never on. `test/aliases.test.js` and `test/links.test.js` drive the tracks directly, with the
same fake and a stub fetch for the artwork checks and short links (and fake DNS for the
guarded fetch), since their links would otherwise ask `i.ytimg.com` or `on.soundcloud.com`.

### In Coolify

Build from the `Dockerfile`. It needs:

- `CANOPY_ACCOUNT_URL`: `https://account.canopysf.com`.
- `CANOPY_ACCOUNT_KEY`: the key of a site named **cmdlp**, made in the account admin's Sites
  tab, granted the **email** field and no other, with quick (unverified) accounts off.
- `ADMIN_EMAIL`: the admin's Canopy Account email.
- A volume at `/app/data`. It holds the API tokens, so without one every restart loses them,
  starts again from the stable yt-dlp, and loses the queue's audio.
- The domain `cmdlp.canopysf.com`, on port 3000, with HTTPS from Coolify's proxy.
  `audioUrl` (and the SoundCloud fallback artwork) start with
  `https://cmdlp.<CANOPY_DOMAIN>`; set `PUBLIC_URL` if that's ever wrong.

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
