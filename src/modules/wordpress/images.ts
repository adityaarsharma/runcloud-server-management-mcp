/**
 * images.ts — Image Optimization for WordPress Uploads
 *
 * Scans the uploads directory for unoptimized images, estimates savings,
 * and optionally runs jpegoptim/optipng/cwebp in-place on the server.
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ImageFileInfo {
  path: string;
  sizeMb: number;
  type: string;
}

export interface ImageTools {
  jpegoptim: boolean;
  optipng: boolean;
  cwebp: boolean;
  pngquant: boolean;
}

export interface ImageScanResult {
  totalImages: number;
  totalSizeMb: number;
  estimatedSavingsMb: number;
  estimatedSavingsPercent: number;
  largestFiles: ImageFileInfo[];
  unoptimizedCount: number;
  webpMissingCount: number;
  toolsAvailable: ImageTools;
}

export interface OptimizationResult {
  processed: number;
  savedMb: number;
  webpCreated: number;
  errors: string[];
  durationSeconds: number;
  summary: string;
}

export interface ImageToolsCheckResult {
  installed: string[];
  missing: string[];
  installCommand: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNumber(raw: string): number {
  const n = parseFloat(raw.trim().replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function checkTool(sshOpts: SSHOptions, name: string): Promise<boolean> {
  const res = await sshExec(sshOpts, `command -v ${name} 2>/dev/null`);
  return res.code === 0 && res.stdout.trim().length > 0;
}

async function getImageTools(sshOpts: SSHOptions): Promise<ImageTools> {
  const [jpegoptim, optipng, cwebp, pngquant] = await Promise.all([
    checkTool(sshOpts, 'jpegoptim'),
    checkTool(sshOpts, 'optipng'),
    checkTool(sshOpts, 'cwebp'),
    checkTool(sshOpts, 'pngquant'),
  ]);
  return { jpegoptim, optipng, cwebp, pngquant };
}

// ─── Scan ────────────────────────────────────────────────────────────────────

export async function scanImages(
  sshOpts: SSHOptions,
  uploadsPath: string
): Promise<ImageScanResult> {
  if (/\.\./.test(uploadsPath)) {
    throw new Error('uploadsPath must not contain ".."');
  }

  const toolsAvailable = await getImageTools(sshOpts);

  // Total image count and size
  const statsRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.gif" -o -iname "*.webp" \\) ` +
    `2>/dev/null | wc -l`
  );
  const totalImages = parseInt(statsRes.stdout.trim(), 10) || 0;

  // Total size in MB
  const sizeRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `-exec du -cm {} + 2>/dev/null | tail -1 | awk '{print $1}'`
  );
  const totalSizeMb = parseNumber(sizeRes.stdout);

  // Largest 10 image files
  const largestRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `-printf '%s %p\\n' 2>/dev/null | sort -rn | head -10`
  );

  const largestFiles: ImageFileInfo[] = [];
  for (const line of largestRes.stdout.split('\n').filter(Boolean)) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const bytes = parseInt(line.slice(0, spaceIdx), 10);
    const path = line.slice(spaceIdx + 1).trim();
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    largestFiles.push({
      path,
      sizeMb: bytes / (1024 * 1024),
      type: ext,
    });
  }

  // Count images larger than 200 KB (likely unoptimized)
  const unoptRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `-size +200k 2>/dev/null | wc -l`
  );
  const unoptimizedCount = parseInt(unoptRes.stdout.trim(), 10) || 0;

  // Count originals missing a .webp counterpart
  const webpMissingRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `2>/dev/null | while read f; do test -f "\${f%.*}.webp" || echo "$f"; done | wc -l`
  );
  const webpMissingCount = parseInt(webpMissingRes.stdout.trim(), 10) || 0;

  // Estimate savings: ~35% for JPEG, ~25% for PNG on average unoptimized images
  const jpegRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" \\) ` +
    `-exec du -cm {} + 2>/dev/null | tail -1 | awk '{print $1}'`
  );
  const pngRes = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f -iname "*.png" ` +
    `-exec du -cm {} + 2>/dev/null | tail -1 | awk '{print $1}'`
  );

  const jpegMb = parseNumber(jpegRes.stdout);
  const pngMb = parseNumber(pngRes.stdout);
  const estimatedSavingsMb = (jpegMb * 0.30) + (pngMb * 0.20);
  const estimatedSavingsPercent = totalSizeMb > 0
    ? Math.round((estimatedSavingsMb / totalSizeMb) * 100)
    : 0;

  return {
    totalImages,
    totalSizeMb,
    estimatedSavingsMb,
    estimatedSavingsPercent,
    largestFiles,
    unoptimizedCount,
    webpMissingCount,
    toolsAvailable,
  };
}

// ─── Optimize ────────────────────────────────────────────────────────────────

export interface OptimizeOptions {
  generateWebp?: boolean;
  losslessOnly?: boolean;
  dryRun?: boolean;
  /**
   * Use pngquant (lossy palette quantization) instead of optipng for PNG
   * compression when available. Saves 60–80% per file vs optipng's 5–25%.
   * Default true. Set false to force lossless-only behavior on PNGs.
   */
  preferPngquant?: boolean;
  /**
   * pngquant quality range (e.g. "75-90"). 80-95 is too tight for truecolor
   * screenshots — pngquant fails the floor and skips. 75-90 lands at
   * perceptual Q≈77, visually indistinguishable for typical web images.
   * Default "75-90".
   */
  pngQualityRange?: string;
  /**
   * Per-tool parallelism. Default 1 (matches legacy serial behavior). Bump to
   * 2-3 for faster runs on multi-core servers; combine with `nicePriority`
   * to avoid impacting live traffic.
   */
  parallelism?: number;
  /** `nice` level (0-19, higher = lower priority). Default 19. */
  nicePriority?: number;
}

export async function optimizeImages(
  sshOpts: SSHOptions,
  uploadsPath: string,
  opts: OptimizeOptions = {}
): Promise<OptimizationResult> {
  if (/\.\./.test(uploadsPath)) {
    throw new Error('uploadsPath must not contain ".."');
  }

  const {
    generateWebp = true,
    losslessOnly = true,
    dryRun = false,
    preferPngquant = true,
    pngQualityRange = '75-90',
    parallelism = 1,
    nicePriority = 19,
  } = opts;
  const errors: string[] = [];
  const startMs = Date.now();

  if (parallelism < 1 || parallelism > 32) throw new Error('parallelism must be 1..32');
  if (nicePriority < 0 || nicePriority > 19) throw new Error('nicePriority must be 0..19');
  if (!/^\d+-\d+$/.test(pngQualityRange)) throw new Error('pngQualityRange must look like "75-90"');

  const tools = await getImageTools(sshOpts);

  // Measure total size before
  const sizeBefore = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `-exec du -cb {} + 2>/dev/null | tail -1 | awk '{print $1}'`
  );
  const bytesBefore = parseNumber(sizeBefore.stdout);

  let processed = 0;
  let webpCreated = 0;

  if (!dryRun) {
    // JPEG optimization with jpegoptim (parallelised + niced)
    if (tools.jpegoptim) {
      const jpegArgs = losslessOnly
        ? '--strip-all --all-progressive'
        : '--strip-all --all-progressive --max=85';
      const jpegRes = await sshExec(
        { ...sshOpts, timeoutMs: 300_000 },
        `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" \\) -print0 ` +
        `| xargs -0 -P ${parallelism} -n 30 nice -n ${nicePriority} ` +
        `jpegoptim ${jpegArgs} 2>&1`
      );
      if (jpegRes.code !== 0) {
        errors.push(`jpegoptim error: ${jpegRes.stderr.slice(0, 200)}`);
      } else {
        const optimizedCount = (jpegRes.stdout.match(/optimized/gi) ?? []).length;
        processed += optimizedCount;
      }
    } else {
      errors.push('jpegoptim not installed — JPEG files not optimized.');
    }

    // PNG optimization — prefer pngquant (lossy palette, ~70% savings) over
    // optipng (lossless, ~10% savings). Falls back if pngquant absent.
    const usePngquant = preferPngquant && tools.pngquant && !losslessOnly;

    if (usePngquant) {
      const pngRes = await sshExec(
        { ...sshOpts, timeoutMs: 600_000 },
        `find ${uploadsPath} -type f -iname "*.png" -print0 ` +
        `| xargs -0 -P ${parallelism} -n 30 nice -n ${nicePriority} ` +
        `pngquant --quality=${pngQualityRange} --skip-if-larger --strip --ext .png --force --speed 4 2>&1`
      );
      if (pngRes.code !== 0 && pngRes.code !== 99) {
        // pngquant returns 99 when --skip-if-larger triggers — not an error
        errors.push(`pngquant error: ${pngRes.stderr.slice(0, 200)}`);
      } else {
        // pngquant has no per-file success line in batch mode; count below via
        // post-size delta. Treat all matched files as candidates.
        const matched = await sshExec(
          sshOpts,
          `find ${uploadsPath} -type f -iname "*.png" 2>/dev/null | wc -l`
        );
        processed += parseInt(matched.stdout.trim(), 10) || 0;
      }
    } else if (tools.optipng) {
      // Lossless fallback (or losslessOnly=true)
      const pngRes = await sshExec(
        { ...sshOpts, timeoutMs: 300_000 },
        `find ${uploadsPath} -type f -iname "*.png" -print0 ` +
        `| xargs -0 -P ${parallelism} -n 30 nice -n ${nicePriority} ` +
        `optipng -o2 -quiet 2>&1`
      );
      if (pngRes.code !== 0) {
        errors.push(`optipng error: ${pngRes.stderr.slice(0, 200)}`);
      } else {
        const pngCount = (pngRes.stdout.match(/OK$/gim) ?? []).length;
        processed += pngCount;
      }
    } else {
      errors.push('Neither pngquant nor optipng installed — PNG files not optimized.');
    }

    // WebP generation with cwebp
    if (generateWebp && tools.cwebp) {
      const webpRes = await sshExec(
        { ...sshOpts, timeoutMs: 600_000 },
        // Generate .webp only if it doesn't already exist
        `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
        `2>/dev/null | while read f; do ` +
        `  dest="\${f%.*}.webp"; ` +
        `  if [ ! -f "$dest" ]; then ` +
        `    cwebp -q 85 -quiet "$f" -o "$dest" 2>/dev/null && echo "created: $dest"; ` +
        `  fi; ` +
        `done`
      );
      if (webpRes.code !== 0) {
        errors.push(`cwebp error: ${webpRes.stderr.slice(0, 200)}`);
      } else {
        webpCreated = (webpRes.stdout.match(/created:/g) ?? []).length;
      }
    }
  }

  // Measure total size after
  const sizeAfter = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
    `-exec du -cb {} + 2>/dev/null | tail -1 | awk '{print $1}'`
  );
  const bytesAfter = parseNumber(sizeAfter.stdout);
  const savedMb = Math.max(0, (bytesBefore - bytesAfter) / (1024 * 1024));

  const durationSeconds = (Date.now() - startMs) / 1000;

  const summary = dryRun
    ? `Dry run — no changes made. Estimated savings: ${savedMb.toFixed(1)} MB.`
    : `Optimized ${processed} images, saved ${savedMb.toFixed(1)} MB, created ${webpCreated} WebP files in ${durationSeconds.toFixed(0)}s.`;

  return { processed, savedMb, webpCreated, errors, durationSeconds, summary };
}

// ─── Tool availability check ──────────────────────────────────────────────────

export async function checkImageTools(
  sshOpts: SSHOptions
): Promise<ImageToolsCheckResult> {
  const tools = await getImageTools(sshOpts);

  const allTools = ['jpegoptim', 'optipng', 'cwebp', 'pngquant'] as const;
  const installed: string[] = [];
  const missing: string[] = [];

  for (const tool of allTools) {
    if (tools[tool]) installed.push(tool);
    else missing.push(tool);
  }

  // Build a single apt-get install command for all missing tools
  const installCommand = missing.length > 0
    ? `sudo apt-get install -y ${missing.join(' ')} webp`
    : '';

  return { installed, missing, installCommand };
}
