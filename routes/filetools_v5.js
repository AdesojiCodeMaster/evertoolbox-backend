// routes/filetools_v5.js
// Final production-ready File Converter + Compressor router (CommonJS).
// - Strict file-type verification using file-type
// - Rate-limit per IP for protection
// - Processing timeouts
// - Streaming download with guaranteed temp cleanup
// - Concurrency guard (semaphore)
// - Clear messages for missing binaries (ffmpeg/gs/libreoffice)
// - Direct download (no zip) for single-file flows

const express = require('express');
const multer = require('multer');
const path = require('path');
const sanitize = require('sanitize-filename');
const tmp = require('tmp-promise');
const fs = require('fs/promises');
const fsSync = require('fs');
const mime = require('mime-types');
const { spawn, execSync } = require('child_process');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// New dependencies used for improved safety
const FileType = require('file-type');               // detect real file type
const rateLimit = require('express-rate-limit');     // protect endpoint

const router = express.Router();

// Configuration - tweak via env vars
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MAX_FILE_SIZE_BYTES || '83886080'); // 80MB
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || '2');
const PROCESS_TIMEOUT_MS = parseInt(process.env.FILE_PROCESS_TIMEOUT_MS || String(2 * 60 * 1000)); // 2 minutes
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.FILE_RATE_WINDOW_MS || '60000'); // 60s
const RATE_LIMIT_MAX = parseInt(process.env.FILE_RATE_MAX || '20'); // per window per IP

// Simple metrics (in-memory)
const metrics = { requests: 0, successes: 0, failures: 0, current: 0 };

let active = 0;
async function acquire() {
  while (active >= MAX_CONCURRENT) await new Promise(r => setTimeout(r, 120));
  active++; metrics.current = active;
}
function release() { active = Math.max(0, active - 1); metrics.current = active; }

function commandExists(cmd) {
  try { const out = execSync(`which ${cmd}`, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); return !!out; } catch (e) { return false; }
}
function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args);
    let stderr = '', stdout = '';
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('error', e => reject(e));
    ps.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit ${code}`)));
  });
}
async function compressGzip(inPath, outPath) {
  const source = fsSync.createReadStream(inPath);
  const dest = fsSync.createWriteStream(outPath);
  const gzip = zlib.createGzip({ level: 9 });
  await pipeline(source, gzip, dest);
}
async function compressBrotli(inPath, outPath) {
  const source = fsSync.createReadStream(inPath);
  const dest = fsSync.createWriteStream(outPath);
  const bro = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  await pipeline(source, bro, dest);
}
async function libreConvertBuffer(buf, toExt) {
  try {
    const libre = require('libreoffice-convert');
    return await new Promise((resolve, reject) => {
      libre.convert(buf, `.${toExt}`, undefined, (err, done) => { if (err) reject(err); else resolve(done); });
    });
  } catch (e) {
    throw new Error('libreoffice-convert npm module not present');
  }
}

// Allowed extensions & mime mapping (tight whitelist)
const ALLOWED_EXT = new Set([
  'jpg','jpeg','png','webp','avif','tiff','svg',
  'pdf',
  'mp3','wav','ogg',
  'mp4','mov','mkv',
  'txt','md','csv','log',
  'doc','docx','rtf','odt'
]);

// multer storage: per-request tmp dir
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = await tmp.dir({ unsafeCleanup: true });
      req._tmpDir = dir;
      cb(null, dir.path);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${sanitize(file.originalname || 'upload')}`)
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

// rate limiter applied to this router
router.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests; slow down' }
}));

// router health & metrics endpoint
router.get('/health', (req, res) => res.json({ status: 'ok', tool: 'filetools_v5', metrics }));

// Helper: sanity check file-type by magic bytes
async function detectFileType(filePath) {
  try {
    const ft = await FileType.fromFile(filePath);
    if (!ft) return null;
    return { ext: ft.ext, mime: ft.mime };
  } catch (e) { return null; }
}

// Workhorse: POST /process
router.post('/process', upload.single('file'), async (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.floor(Math.random()*10000)}`;
  metrics.requests++;
  let timeoutHandle = null;
  let timedOut = false;

  if (!req.file) { await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'No file uploaded' }); }

  // Basic defensive checks
  if (Array.isArray(req.files) && req.files.length > 1) { await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'Only one file allowed' }); }

  const rawTarget = (req.body.targetFormat || '').toString().trim().toLowerCase();
  const quality = Math.max(1, Math.min(100, parseInt(req.body.quality || '80')));
  const action = (req.body.action || '').toString().trim().toLowerCase(); // 'convert' | 'compress' | ''
  let edits = null; try { if (req.body.edits) edits = JSON.parse(req.body.edits); } catch (e) {}

  const inputPath = req.file.path;
  const originalName = sanitize(req.file.originalname || 'file');
  const inputExtRaw = path.extname(originalName).replace('.', '').toLowerCase();
  const base = path.basename(originalName, path.extname(originalName));

  // Start processing timeout guard
  const cleanupAndTimeout = async (msg, status=500) => {
    try { await cleanupTmp(req); } catch(e) {}
    if (!res.headersSent) res.status(status).json({ error: msg });
    metrics.failures++;
  };

  // Start timer
  const procTimer = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => { timedOut = true; reject(new Error('Processing timed out')); }, PROCESS_TIMEOUT_MS);
  });

  await acquire();
  try {
    // Verify actual type
    const detected = await detectFileType(inputPath);
    const detectedExt = detected ? detected.ext : null;
    const detectedMime = detected ? detected.mime : null;

    // If we can't detect but extension is safe, allow; otherwise reject
    if (!detectedExt && !ALLOWED_EXT.has(inputExtRaw)) {
      await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'Unable to detect file type or unsupported extension' });
    }
    const allowedInputExt = detectedExt || inputExtRaw;
    if (!ALLOWED_EXT.has(allowedInputExt)) {
      await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Normalize target
    const targetRaw = rawTarget;
    const target = targetRaw === 'jpg' ? 'jpeg' : (targetRaw === 'gz' ? 'gzip' : (targetRaw === 'br' ? 'brotli' : targetRaw));
    const normInput = inputExtRaw === 'jpg' ? 'jpeg' : inputExtRaw;

    // Same-format protection (unless user explicitly asked compress)
    if (target && normInput === target && action !== 'compress' && !['gzip','brotli'].includes(target)) {
      await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'Uploaded file already in selected format' });
    }

    // Quick security check for svg text content
    if (inputExtRaw === 'svg') {
      try {
        const txt = await fs.readFile(inputPath, 'utf8');
        const l = txt.toLowerCase();
        if (l.includes('<script') || l.includes('javascript:') || l.includes('onload=') || l.includes('xlink:href')) {
          await cleanupTmp(req); metrics.failures++; return res.status(400).json({ error: 'Unsafe SVG content detected' });
        }
      } catch (e) {}
    }

    // Begin actual processing but enforce timeout using Promise.race
    const processPromise = (async () => {
      const mimeType = mime.lookup(inputPath) || detectedMime || '';
      // Out ext and path decision
      let outExt = target ? (target === 'gzip' ? 'gz' : (target === 'brotli' ? 'br' : (target === 'jpeg' ? 'jpg' : target))) : inputExtRaw;
      let outPath = path.join(path.dirname(inputPath), `${base}-out.${outExt}`);

      // IMAGE (sharp)
      if (mimeType.startsWith('image/') || ['jpg','jpeg','png','webp','avif','tiff','svg'].includes(inputExtRaw)) {
        const sharp = require('sharp');
        let img = sharp(inputPath, { failOnError: false });
        if (edits && typeof edits === 'object') {
          if (edits.rotate) img = img.rotate(edits.rotate);
          if (edits.crop && edits.crop.width && edits.crop.height) {
            const c = edits.crop;
            img = img.extract({ left: Math.max(0,c.left||0), top: Math.max(0,c.top||0), width: c.width, height: c.height });
          }
        }
        if (req.body.width || req.body.height) {
          const w = req.body.width ? parseInt(req.body.width) : null;
          const h = req.body.height ? parseInt(req.body.height) : null;
          img = img.resize(w, h, { fit: 'inside' });
        }
        const targetFmt = target || inputExtRaw;
        const fmt = (targetFmt === 'jpg' ? 'jpeg' : targetFmt);
        outPath = path.join(path.dirname(inputPath), `${base}-out.${fmt === 'jpeg' ? 'jpg' : fmt}`);
        if (['jpeg','jpg'].includes(fmt)) await img.jpeg({ quality, mozjpeg: true }).toFile(outPath);
        else if (fmt === 'webp') await img.webp({ quality }).toFile(outPath);
        else if (fmt === 'png') await img.png({ compressionLevel: Math.round((100-quality)/10) }).toFile(outPath);
        else if (fmt === 'avif') await img.avif({ quality }).toFile(outPath);
        else await img.toFile(outPath);

      // DOC/DOCX -> pdf/txt/html via libreoffice
      } else if (['doc','docx','rtf','odt'].includes(inputExtRaw)) {
        if (['pdf','txt','html'].includes(target)) {
          if (!commandExists('libreoffice') && !commandExists('soffice')) throw new Error('LibreOffice not available on server for document conversions');
          const buf = await fs.readFile(inputPath);
          const converted = await libreConvertBuffer(buf, target === 'txt' ? 'txt' : (target === 'html' ? 'html' : 'pdf'));
          outPath = path.join(path.dirname(inputPath), `${base}-out.${target}`);
          await fs.writeFile(outPath, converted);
        } else if (['gzip','brotli'].includes(target)) {
          if (target === 'gzip') { outPath = path.join(path.dirname(inputPath), `${base}.docx.gz`); await compressGzip(inputPath, outPath); }
          else { outPath = path.join(path.dirname(inputPath), `${base}.docx.br`); await compressBrotli(inputPath, outPath); }
        } else {
          await fs.copyFile(inputPath, outPath);
        }

      // Plain text types
      } else if (['txt','md','csv','log'].includes(inputExtRaw)) {
        if (target === 'gzip') { outPath = path.join(path.dirname(inputPath), `${base}.txt.gz`); await compressGzip(inputPath, outPath); }
        else if (target === 'brotli') { outPath = path.join(path.dirname(inputPath), `${base}.txt.br`); await compressBrotli(inputPath, outPath); }
        else if (target === 'pdf') {
          if (!commandExists('libreoffice') && !commandExists('soffice')) { await fs.copyFile(inputPath, outPath); }
          else {
            const buf = await fs.readFile(inputPath);
            const converted = await libreConvertBuffer(buf, 'pdf');
            outPath = path.join(path.dirname(inputPath), `${base}-out.pdf`); await fs.writeFile(outPath, converted);
          }
        } else { await fs.copyFile(inputPath, outPath); }

      // PDF compression via ghostscript
      } else if (inputExtRaw === 'pdf' || mimeType === 'application/pdf') {
        if (target !== 'pdf') { await fs.copyFile(inputPath, outPath); }
        else {
          if (!commandExists('gs')) throw new Error('ghostscript (gs) not available on server for PDF compression');
          const tmpOut = path.join(path.dirname(inputPath), `${base}-compressed.pdf`);
          const setting = quality <= 40 ? '/screen' : (quality <= 75 ? '/ebook' : '/printer');
          await runCmd('gs', ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4',`-dPDFSETTINGS=${setting}`,'-dNOPAUSE','-dQUIET','-dBATCH',`-sOutputFile=${tmpOut}`, inputPath]);
          await fs.rename(tmpOut, outPath);
        }

      // Audio/Video via ffmpeg
      } else if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
        if (!commandExists('ffmpeg')) throw new Error('ffmpeg not available on server for audio/video processing');
        const audioBR = Math.max(32, Math.floor((quality/100)*192));
        const videoBR = Math.max(200, Math.floor((quality/100)*2500));
        outPath = path.join(path.dirname(inputPath), `${base}-out.${outExt}`);
        if (mimeType.startsWith('audio/')) await runCmd('ffmpeg', ['-y','-i', inputPath, '-vn', '-b:a', `${audioBR}k`, outPath]);
        else await runCmd('ffmpeg', ['-y','-i', inputPath, '-b:v', `${videoBR}k`, '-b:a', `${audioBR}k`, outPath]);

      } else {
        await fs.copyFile(inputPath, outPath);
      }

      return outPath;
    })();

    // Use Promise.race to guard with timeout
    const outPath = await Promise.race([ processPromise, procTimer ]);

    // If timed out flag set, fail
    if (timedOut) {
      await cleanupAndTimeout('Processing timed out', 503);
      return;
    }
    clearTimeout(timeoutHandle);

    // Validate out exists
    if (!fsSync.existsSync(outPath)) { await cleanupAndTimeout('Output file not produced', 500); return; }

    // Set security headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(path.basename(outPath))}"`);
    res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Stream file and cleanup after finish/close/error
    const readStream = fsSync.createReadStream(outPath);
    readStream.on('error', async (err) => {
      console.error(`[${reqId}] stream error:`, err);
      try { await cleanupTmp(req); } catch(e) {}
      if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });
    res.on('close', async () => {
      try { if (fsSync.existsSync(outPath)) fsSync.unlinkSync(outPath); } catch(e) {}
      try { await cleanupTmp(req); } catch(e) {}
    });
    readStream.on('end', async () => {
      try { if (fsSync.existsSync(outPath)) fsSync.unlinkSync(outPath); } catch(e) {}
      try { await cleanupTmp(req); } catch(e) {}
      metrics.successes++;
    });

    readStream.pipe(res);

  } catch (err) {
    clearTimeout(timeoutHandle);
    console.error(`[${reqId}] processing failed:`, err && (err.stack || err.message) ? (err.stack || err.message) : err);
    try { await cleanupTmp(req); } catch (e) {}
    metrics.failures++;
    // user-facing message: be explicit but not leaking internal stack
    const msg = err && err.message ? err.message : 'Processing failed';
    return res.status(500).json({ error: msg });
  } finally {
    release();
  }
});

// cleanup helper
async function cleanupTmp(req) {
  try { if (req && req._tmpDir && req._tmpDir.cleanup) await req._tmpDir.cleanup(); } catch (e) {}
}

module.exports = router;
    
