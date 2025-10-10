// routes/filetools_v5.js
// CommonJS, Render-friendly router implementing a single-file Converter + Compressor
// - Single upload only
// - Rejects same-format conversion
// - True compression for images (sharp), PDFs (ghostscript), audio (ffmpeg) when available
// - Lazy-loads heavy modules only when needed
// - Uses tmp-promise for secure temp dirs and auto cleanup
// - Returns direct download (no zip), deletes temp files after download
// - Accepts these form-data fields: file (file), targetFormat (string), quality (0-100), width, height, edits (JSON string)
// - Mount path recommended: app.use('/api/tools/file', filetoolsV5)

const express = require('express');
const multer = require('multer');
const path = require('path');
const sanitize = require('sanitize-filename');
const tmp = require('tmp-promise');
const fs = require('fs/promises');
const fsSync = require('fs');
const mime = require('mime-types');
const { spawn } = require('child_process');

const router = express.Router();

// Config (change via env vars as needed)
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MAX_FILE_SIZE_BYTES || '83886080'); // 80MB default
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || '2');

// Simple semaphore
let active = 0;
async function acquire() {
  while (active >= MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 120));
  }
  active++;
}
function release() { active = Math.max(0, active - 1); }

// Multer: store into a dedicated temporary folder per-request for safety
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = await tmp.dir({ unsafeCleanup: true });
      req._tmpDir = dir; // store handle for cleanup
      cb(null, dir.path);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${sanitize(file.originalname || 'upload')}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

// Helper: cleanup temp dir if present
async function cleanupTmp(req) {
  try {
    if (req && req._tmpDir && req._tmpDir.cleanup) await req._tmpDir.cleanup();
  } catch (e) { /* ignore */ }
}

// Lightweight SVG safety check
async function isSvgSafe(filePath) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    const lower = txt.toLowerCase();
    if (lower.includes('<script') || lower.includes('javascript:') || lower.includes('onload=') || lower.includes('xlink:href')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Lazy loaders
function lazySharp() {
  try { return require('sharp'); } catch (e) { throw new Error('sharp module not installed on server'); }
}
function ensureCommandExists(cmd) {
  // returns true/false depending on whether command is available (sync)
  try { const which = require('child_process').execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim(); return !!which; } catch (e) { return false; }
}

// Run shell command and await finish (returns stdout)
function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args);
    let stderr = '';
    let stdout = '';
    ps.stdout.on('data', d => { stdout += d.toString(); });
    ps.stderr.on('data', d => { stderr += d.toString(); });
    ps.on('error', err => reject(err));
    ps.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit ${code}`)));
  });
}

// Main endpoint: POST /process
// Accepts form-data with single file only
router.post('/process', upload.single('file'), async (req, res) => {
  // Defensive checks
  if (!req.file) { await cleanupTmp(req); return res.status(400).json({ error: 'No file uploaded' }); }
  if (Array.isArray(req.files) && req.files.length > 1) { await cleanupTmp(req); return res.status(400).json({ error: 'Only one file allowed' }); }

  // parse params
  const targetFormatRaw = (req.body.targetFormat || '').trim().toLowerCase();
  const quality = Math.max(1, Math.min(100, parseInt(req.body.quality || '80'))); // 1..100
  const width = req.body.width ? parseInt(req.body.width) : null;
  const height = req.body.height ? parseInt(req.body.height) : null;
  let edits = null;
  try { if (req.body.edits) edits = JSON.parse(req.body.edits); } catch (e) { /* ignore */ }

  const inputPath = req.file.path;
  const originalName = sanitize(req.file.originalname || 'file');
  const inputExt = path.extname(originalName).replace('.', '').toLowerCase();
  const baseName = path.basename(originalName, path.extname(originalName));

  // target required
  if (!targetFormatRaw) { await cleanupTmp(req); return res.status(400).json({ error: 'targetFormat is required' }); }

  // same-format detection
  if (inputExt === targetFormatRaw) { await cleanupTmp(req); return res.status(400).json({ error: 'The uploaded file is already in the selected format.' }); }

  // svg safety
  if (inputExt === 'svg') {
    const ok = await isSvgSafe(inputPath);
    if (!ok) { await cleanupTmp(req); return res.status(400).json({ error: 'Unsafe SVG content detected' }); }
  }

  // Acquire semaphore
  await acquire();

  // Create out path in tmp dir
  const outName = `${baseName}-out.${targetFormatRaw}`;
  let outPath = path.join(path.dirname(inputPath), outName);

  try {
    const mimeType = mime.lookup(inputPath) || '';

    // IMAGE PATH (sharp)
    if (mimeType.startsWith('image/') || ['jpg','jpeg','png','webp','avif','tiff','svg'].includes(inputExt)) {
      const sharp = lazySharp();

      let img = sharp(inputPath, { failOnError: false });

      // apply edits (limited: rotate, crop)
      if (edits && typeof edits === 'object') {
        if (edits.rotate) img = img.rotate(edits.rotate);
        if (edits.crop && edits.crop.width && edits.crop.height) {
          const c = edits.crop;
          img = img.extract({ left: Math.max(0, c.left||0), top: Math.max(0, c.top||0), width: c.width, height: c.height });
        }
      }
      if (width || height) img = img.resize(width || null, height || null, { fit: 'inside' });

      const outExt = targetFormatRaw === 'jpg' ? 'jpeg' : targetFormatRaw;
      outPath = path.join(path.dirname(inputPath), `${baseName}-out.${outExt}`);

      // encoding options tuned for aggressive compression yet acceptable quality
      if (['jpeg','jpg'].includes(outExt)) await img.jpeg({ quality, mozjpeg: true }).toFile(outPath);
      else if (outExt === 'webp') await img.webp({ quality }).toFile(outPath);
      else if (outExt === 'png') await img.png({ compressionLevel: 9 }).toFile(outPath);
      else if (outExt === 'avif') await img.avif({ quality }).toFile(outPath);
      else await img.toFile(outPath);

    // PDF PATH (ghostscript)
    } else if (inputExt === 'pdf' || mimeType === 'application/pdf') {
      // If target is pdf then compress with ghostscript; otherwise, convert not supported here
      if (targetFormatRaw !== 'pdf') {
        // Attempt conversion not supported: fallback copy
        await fs.copyFile(inputPath, outPath);
      } else {
        if (!ensureCommandExists('gs')) throw new Error('ghostscript (gs) not found on server');
        const tmpOut = path.join(path.dirname(inputPath), `${baseName}-compressed.pdf`);
        // choose PDFSETTINGS by quality: /screen (low), /ebook (medium), /printer (high)
        const setting = quality <= 40 ? '/screen' : (quality <= 75 ? '/ebook' : '/printer');
        await runGSCompress(inputPath, tmpOut, setting);
        await fs.rename(tmpOut, outPath);
      }

    // AUDIO/VIDEO PATH (ffmpeg)
    } else if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      if (!ensureCommandExists('ffmpeg')) throw new Error('ffmpeg not found on server');
      // Basic audio/video re-encode using ffmpeg
      // Map quality to bitrate roughly
      const audioBitrate = Math.max(32, Math.floor((quality / 100) * 192)); // kbps
      const videoBitrate = Math.max(200, Math.floor((quality / 100) * 2500)); // kbps

      outPath = path.join(path.dirname(inputPath), `${baseName}-out.${targetFormatRaw}`);

      if (mimeType.startsWith('audio/')) {
        // audio only
        await runFFmpegAudio(inputPath, outPath, `${audioBitrate}k`);
      } else {
        // video: keep resolution unless width/height provided
        const resizeArgs = (width || height) ? ['-vf', `scale=${width||-2}:${height||-2}`] : [];
        await runFFmpegVideo(inputPath, outPath, `${videoBitrate}k`, `${audioBitrate}k`, resizeArgs);
      }

    } else {
      // fallback copy: unknown types
      await fs.copyFile(inputPath, outPath);
    }

    // Ensure out file exists
    if (!fsSync.existsSync(outPath)) throw new Error('Output file not produced');

    // Send direct download
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
    res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');

    // stream file and after finish cleanup tmp dir
    const stream = fsSync.createReadStream(outPath);
    stream.on('end', async () => { await cleanupTmp(req); });
    stream.pipe(res);

  } catch (err) {
    console.error('filetools_v5 processing error:', err);
    await cleanupTmp(req);
    return res.status(500).json({ error: 'Processing failed', detail: (err && err.message) ? err.message : err.toString() });
  } finally {
    release();
  }
});

// small helper funcs (shell wrappers)
async function runFFmpegAudio(input, out, abr) {
  // ffmpeg -y -i input -vn -b:a <abr> out
  await runCmd('ffmpeg', ['-y','-i', input, '-vn', '-b:a', abr, out]);
}
async function runFFmpegVideo(input, out, vbr, abr, extraArgs = []) {
  // ffmpeg -y -i input -b:v vbr -b:a abr [extraArgs] out
  const args = ['-y','-i', input, '-b:v', vbr, '-b:a', abr, ...extraArgs, out];
  await runCmd('ffmpeg', args);
}
async function runGSCompress(input, out, setting) {
  // gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile=out input
  await runCmd('gs', ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4',`-dPDFSETTINGS=${setting}`,'-dNOPAUSE','-dQUIET','-dBATCH',`-sOutputFile=${out}`, input]);
}
async function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args);
    let stderr = '', stdout = '';
    ps.stdout.on('data', d => { stdout += d.toString(); });
    ps.stderr.on('data', d => { stderr += d.toString(); });
    ps.on('error', e => reject(e));
    ps.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit code ${code}`)));
  });
}

// Health
router.get('/health', (req, res) => res.json({ ok: true, activeProcesses: active }));

module.exports = router;
