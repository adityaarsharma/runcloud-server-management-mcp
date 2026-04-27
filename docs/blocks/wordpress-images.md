# WordPress Image Compression

The `src/modules/wordpress/images*.ts` files give Perch two complementary
image-optimization paths:

- **Synchronous** (`images.ts` → `optimizeImages`) — for sites with up to a
  few thousand image files. Runs inside a single SSH exec, returns when
  done.
- **Bulk / background** (`images-bulk.ts`) — for real-world WP installs with
  tens of thousands of files. Launches a detached `tmux` session on the
  remote server, writes progress to `~/perch-jobs/<jobId>/`, exposes
  status/cancel calls.

Both paths default to **pngquant** (lossy palette quantization) for PNG and
**jpegoptim** for JPEG, with `nice -n 19` and `xargs -P` parallelism so the
live site stays responsive.

---

## Why pngquant, not optipng

| Tool | Type | Typical PNG savings | Notes |
|---|---|---|---|
| `optipng` | Lossless | 5–25% | Pixel-identical. Slow. Was Perch's original PNG path. |
| `pngquant` | Lossy palette | **60–80%** | Visually indistinguishable at quality 75-90. Used by Google, ImageOptim, TinyPNG. |
| `cwebp` | Format change | 80–90% | Requires DB rewrite or `.htaccess` rule. Out of scope for this module. |

A real audit (2026-04-27, 51 GB / 47,613-PNG WordPress install) compressed
from **51 GB → 26 GB (49.4% saved)** in 3h13m using pngquant at quality
75-90, parallelism 3, on a 3-core RunCloud server. The site stayed at
HTTP 200 throughout.

---

## Quality range

Default: `--quality=75-90`.

`80-95` is too tight for typical truecolor screenshots / photos — pngquant
can't meet the floor and skips with exit 99. Field-tested 75-90 lands at
perceptual `Q≈77` (pngquant's own metric); MSE on a 12 MB sample was 6.92,
visually clean.

If you have a heavily-vector or low-color asset library (logos, UI
diagrams), tighten to `85-95` for stricter quality. If size matters more
than fidelity (long-tail blog archive), loosen to `65-85`.

---

## Synchronous: `optimizeImages`

```ts
import { optimizeImages } from './modules/wordpress/images.js';

await optimizeImages(sshOpts, '/home/user/webapps/wp/wp-content/uploads', {
  losslessOnly: false,        // turn this off to enable pngquant
  preferPngquant: true,       // default true
  pngQualityRange: '75-90',   // default
  parallelism: 2,             // default 1
  nicePriority: 19,           // default 19
  generateWebp: true,         // default true
  dryRun: false,
});
```

Set `losslessOnly: true` for the strict-no-quality-loss path
(jpegoptim --strip-all + optipng -o2). Useful when working with a stock
library or stricter compliance.

`generateWebp: true` produces sibling `.webp` files for any `.jpg`/`.png`
without one (does not delete the originals). Pair with a
serve-WebP-via-`.htaccess` rule for free bandwidth wins.

### HTTP API

```
POST /api/wp.images_optimize
{
  "host": "...", "username": "...", "password": "...",
  "uploadsPath": "/home/user/.../wp-content/uploads",
  "losslessOnly": false,
  "confirm": true
}
```

`confirm: true` is required — this is a mutating call.

---

## Bulk / background: `startBulkCompression`

For sites where the synchronous call would time out (tens of GB / tens of
thousands of files):

```ts
import {
  startBulkCompression,
  getBulkCompressionStatus,
  cancelBulkCompression,
} from './modules/wordpress/images-bulk.js';

// 1. Kick it off (returns immediately)
const job = await startBulkCompression(sshOpts, uploadsPath, {
  pngQualityRange: '75-90',
  parallelism: 3,
  nicePriority: 19,
  includeJpeg: false,    // PNG-first; flip to true to also pass JPEGs
});
// → { jobId, startedAt, pngCountTotal, bytesBefore, tmuxSession, stateDir }

// 2. Poll status as often as you like
const s = await getBulkCompressionStatus(sshOpts, job.jobId);
// → { state, percentDone, percentSaved, etaSeconds, bytesSaved, ... }

// 3. Cancel if needed (idempotent)
await cancelBulkCompression(sshOpts, job.jobId);
```

State is kept on the remote at `~/perch-jobs/<jobId>/`:

```
~/perch-jobs/wp-img-20260427T140710Z-a4f1/
├── baseline.env       # JOB_START_TS, UPLOADS_BEFORE_BYTES, PNG_COUNT
├── worker.sh          # the actual job script
├── progress.log       # heartbeat: timestamp, processed_count, bytes, free
├── heartbeat.pid      # PID of the heartbeat loop (cancellable)
└── result.json        # written when job completes
```

Resume after cancel-and-relaunch is automatic: pngquant skips files newer
than `baseline.env`, and the worker's `find -not -newer` filter only feeds
unprocessed files into xargs.

### HTTP API

```
POST /api/wp.images_compress_bulk_start
{
  "host": "...", "username": "...", "password": "...",
  "uploadsPath": "/home/user/.../wp-content/uploads",
  "parallelism": 3,
  "confirm": true
}

POST /api/wp.images_compress_bulk_status
{
  "host": "...", "username": "...", "password": "...",
  "jobId": "wp-img-..."
}

POST /api/wp.images_compress_bulk_cancel  { ..., "jobId": "...", "confirm": true }
POST /api/wp.images_compress_bulk_list    { ... }
POST /api/wp.images_compress_bulk_cleanup { ..., "jobId": "...", "confirm": true }
```

---

## Required tools on the remote

`tmux`, `pngquant`, `find`, `xargs`, `nice` — for the bulk path.

`jpegoptim`, `optipng`, `cwebp` — optional, used by `optimizeImages` when
present.

Install on Ubuntu/Debian (RunCloud default):

```bash
sudo apt-get install -y pngquant jpegoptim optipng webp tmux
```

`checkImageTools(sshOpts)` returns the gap + the exact apt-get command for
any missing tools.

---

## Safety guarantees

The job changes file *contents* in place but **never renames or moves**:

- File path stays identical → WordPress URLs in posts/DB stay valid.
- File extension stays `.png` → no `.htaccess`/DB rewrite needed.
- File dimensions unchanged → registered thumbnail sizes still match.
- File mtime updates (used as a "processed" marker for resume) — does not
  affect WordPress functionality, may invalidate page caches (purge after).

`--skip-if-larger` ensures pngquant never produces a bigger file than the
original — already-optimal files are left untouched.

`nice -n 19` keeps the workers at the lowest CPU priority; the live site
keeps responding normally throughout the job.

---

## Operational notes

- For a site with a CDN (Cloudflare, BunnyCDN, etc.) the originals are
  served from edge until purged. Trigger a full cache purge after the job
  to push the new lighter images to visitors.
- WordPress' "regenerate thumbnails" plugin is **not** needed — thumbnail
  sizes are unchanged, just smaller.
- If parts of the uploads tree are owned by a different user (root, www-
  data, etc.), pngquant running as the webapp user will skip those files
  silently. Run a separate pass after `chown -R` if you want to cover them.
- Estimate peak disk usage during the job: pngquant writes the new file
  then renames it — needs ~2× the *single biggest file*, not the whole
  uploads tree, in transient headroom. A 12 MB PNG needs 24 MB temp space.

---

## Roadmap (separate PRs)

- `wp.audit_disk` — full breakdown of `wp-content/` (uploads / plugins /
  themes / cache / backups), top-N largest files by year, identify
  thumbnail bloat.
- `wp.scan_malware` — flag suspicious files at WP root (random-hash PHP,
  `eval(base64_decode(...))` patterns, recently-modified core files).
- `wp.clean_thumbnails` — list registered image sizes, cross-reference
  with active themes/plugins, propose unused sizes for removal +
  thumbnail regeneration.
