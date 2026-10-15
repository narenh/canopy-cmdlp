# canopy-cmdlp

The README is the reference for how everything works and why; keep it in step with the code. openapi.yaml is the API, and `npm test` checks it lists exactly the routes in server.js.

- Never add yt-dlp's `generic` extractor (or `default`/`all`) to `EXTRACTORS` in lib/ytdlp.js: it fetches any URL, internal addresses included.
- Arguments go to yt-dlp and ffmpeg through `run()` (lib/run.js), never a shell, with `--` before a link.
- API tokens live in DATA_DIR/tokens.json as hashes only; never log or store a token itself. `ADMIN_EMAIL` has no default in the code: unset means nobody gets into /admin.
- The tests use test/fake-yt-dlp.js and a fake Canopy Accounts, not the network. Real links are tried by hand against the Docker image (README.md > Trying it).

## Copy rules (everything people read: errors, docs, the README)

- **"Canopy Music"**, never a bare "Canopy". The same goes for other
  Canopy product names ("Canopy Account", "Canopy Events").
- The Oxford comma: "YouTube, SoundCloud, Bandcamp, Mixcloud, and archive.org".
- **US spelling**: color, not colour.
