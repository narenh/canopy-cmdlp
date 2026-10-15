# Canopy cmdlp

`cmdlp.canopysf.com`. A small API around [yt-dlp](https://github.com/yt-dlp/yt-dlp) that lets
guests at a Canopy Music party queue tracks from YouTube, SoundCloud, and other places the
music services don't carry: rare recordings, live sets, and the like.

The plan:

- A guest pastes a link. The service looks it up and returns the title, artist, length, and
  artwork.
- Once the track is queued, the service downloads its audio in the background and caches it, so
  it's ready by the time it plays.
- The cache for a zone is deleted when the zone ends.
- yt-dlp updates itself to the latest nightly build, with no one touching it.

Deployed on Coolify from the `Dockerfile` in this repo.

Not built yet.
