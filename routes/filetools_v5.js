// routes/filetools_v5.js
// CommonJS router: extended Converter + Compressor including text and docx handling.
// Paste and replace your current routes/filetools_v5.js with this file.

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

const router = express.Router();

// Config
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MAX_FILE_SIZE_BYTES || '83886080'); // 80MB
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || '2');

let active = 0;
async function acquire() {
  while (active >= MAX_CONCURRENT) await new Promise(r => setTimeout(r, 120));
  active++;
}
function release() { active = Math.max(0, active - 1); }

// Multer: per-request temp dir
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

// helpers
async function cleanupTmp(req) {
  try { if (req && req._tmpDir && req._tmpDir.cleanup) await req._tmpDir.cleanup(); } catch (e) {}
}
async function isSvgSafe(fp) {
  try {
    const txt = await fs.readFile(fp, 'utf8');
    const lower = txt.toLowerCase();
    if (lower.includes('<script') || lower.includes('javascript:') || lower.includes('onload=') || lower.includes('xlink:href')) return false;
    return true;
  } catch (e) { return false; }
}
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

// Libreoffice convert helper (lazy)
async function libreConvertBuffer(buf, toExt) {
  let libre;
  try { libre = require('libreoffice-convert'); } catch (e) { throw new Error('libreoffice-convert npm module not installed'); }
  return new Promise((resolve, reject) => {
    libre.convert(buf, `.${toExt}`, undefined, (err, done) => {
      if (err) return reject(err);
      resolve(done);
    });
  });
}

// gzip / brotli compression helpers
async function compressGzip(inputPath, outPath) {
  const source = fsSync.createReadStream(inputPath);
  const dest = fsSync.createWriteStream(outPath);
  const gzip = zlib.createGzip({ level: 9 });
  await pipeline(source, gzip, dest);
}
async function compressBrotli(inputPath, outPath) {
  const source = fsSync.createReadStream(inputPath);
  const dest = fsSync.createWriteStream(outPath);
  const bro = zlib.createBrotliCompress({
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  });
  await pipeline(source, bro, dest);
}

// health
router.get('/health', (req, res) => res.json({ status: 'ok', tool: 'filetools_v5', activeProcesses: active }));

// Main: POST /process
router.post('/process', upload.single('file'), async (req, res) => {
  if (!req.file) { await cleanupTmp(req); return res.status(400).json({ error: 'No file uploaded' }); }
  if (Array.isArray(req.files) && req.files.length > 1) { await cleanupTmp(req); return res.status(400).json({ error: 'Only one file allowed' }); }

  const targetRaw = (req.body.targetFormat || '').toLowerCase().trim();
  const quality = Math.max(1, Math.min(100, parseInt(req.body.quality || '80')));
  const width = req.body.width ? parseInt(req.body.width) : null;
  const height = req.body.height ? parseInt(req.body.height) : null;
  let edits = null;
  try { if (req.body.edits) edits = JSON.parse(req.body.edits); } catch (e) {}

  const inputPath = req.file.path;
  const originalName = sanitize(req.file.originalname || 'file');
  const inputExt = path.extname(originalName).replace('.', '').toLowerCase();
  const base = path.basename(originalName, path.extname(originalName));

  if (!targetRaw) { await cleanupTmp(req); return res.status(400).json({ error: 'targetFormat required' }); }

  // Normalize target (allow synonyms)
  const target = (targetRaw === 'jpg') ? 'jpeg' : (targetRaw === 'gz' ? 'gzip' : (targetRaw === 'br' ? 'brotli' : targetRaw));

  // same-format detection (treat jpeg/jpg equivalently)
  const normInput = (inputExt === 'jpg') ? 'jpeg' : inputExt;
  if (normInput === target && !['gzip','brotli'].includes(target)) {
    await cleanupTmp(req);
    return res.status(400).json({ error: 'The uploaded file is already in the selected format.' });
  }

  // svg safety
  if (inputExt === 'svg') {
    const ok = await isSvgSafe(inputPath);
    if (!ok) { await cleanupTmp(req); return res.status(400).json({ error: 'Unsafe SVG detected' }); }
  }

  await acquire();
  try {
    const mimeType = mime.lookup(inputPath) || '';
    let outExt = target === 'gzip' ? 'gz' : (target === 'brotli' ? 'br' : (target === 'jpeg' ? 'jpg' : target));
    let outPath = path.join(path.dirname(inputPath), `${base}-out.${outExt}`);

    // ---- IMAGE ----
    if (mimeType.startsWith('image/') || ['jpg','jpeg','png','webp','avif','tiff','svg'].includes(inputExt)) {
      let sharp;
      try { sharp = require('sharp'); } catch (e) { throw new Error('sharp module missing'); }

      let img = sharp(inputPath, { failOnError: false });
      if (edits && typeof edits === 'object') {
        if (edits.rotate) img = img.rotate(edits.rotate);
        if (edits.crop && edits.crop.width && edits.crop.height) {
          const c = edits.crop;
          img = img.extract({ left: Math.max(0, c.left||0), top: Math.max(0, c.top||0), width: c.width, height: c.height });
        }
      }
      if (width || height) img = img.resize(width || null, height || null, { fit: 'inside' });

      const fmt = (target === 'jpeg' ? 'jpeg' : target);
      outPath = path.join(path.dirname(inputPath), `${base}-out.${fmt === 'jpeg' ? 'jpg' : fmt}`);

      if (fmt === 'jpeg') await img.jpeg({ quality, mozjpeg: true }).toFile(outPath);
      else if (fmt === 'webp') await img.webp({ quality }).toFile(outPath);
      else if (fmt === 'png') await img.png({ compressionLevel: 9 }).toFile(outPath);
      else if (fmt === 'avif') await img.avif({ quality }).toFile(outPath);
      else await img.toFile(outPath);

    // ---- DOCX / DOC (office) ----
    } else if (['doc','docx','rtf','odt'].includes(inputExt)) {
      // If target is pdf or txt, try libreoffice-convert
      if (['pdf','txt','odt','html'].includes(target)) {
        // lazy check for libreoffice-convert npm package and libre binary
        try {
          if (!commandExists('libreoffice') && !commandExists('soffice')) throw new Error('LibreOffice not found on server');
          const buf = await fs.readFile(inputPath);
          const converted = await libreConvertBuffer(buf, target === 'txt' ? 'txt' : (target === 'odt' ? 'odt' : (target === 'html' ? 'html' : 'pdf')));
          outPath = path.join(path.dirname(inputPath), `${base}-out.${target === 'jpeg' ? 'jpg' : target}`);
          await fs.writeFile(outPath, converted);
        } catch (e) {
          throw new Error('Document conversion failed: ' + (e && e.message ? e.message : e));
        }
      } else if (['gzip','brotli'].includes(target)) {
        // compress docx as binary
        if (target === 'gzip') { outPath = path.join(path.dirname(inputPath), `${base}.docx.gz`); await compressGzip(inputPath, outPath); }
        else { outPath = path.join(path.dirname(inputPath), `${base}.docx.br`); await compressBrotli(inputPath, outPath); }
      } else {
        // fallback: copy
        await fs.copyFile(inputPath, outPath);
      }

    // ---- PLAIN TEXT (.txt, .md, .csv) ----
    } else if (['txt','md','csv','log'].includes(inputExt)) {
      if (target === 'gzip') {
        outPath = path.join(path.dirname(inputPath), `${base}.txt.gz`);
        await compressGzip(inputPath, outPath);
      } else if (target === 'brotli') {
        outPath = path.join(path.dirname(inputPath), `${base}.txt.br`);
        await compressBrotli(inputPath, outPath);
      } else if (target === 'pdf') {
        // Convert text -> pdf using libre if available
        try {
          if (!commandExists('libreoffice') && !commandExists('soffice')) throw new Error('LibreOffice not found on server');
          const buf = await fs.readFile(inputPath);
          const converted = await libreConvertBuffer(buf, 'pdf');
          outPath = path.join(path.dirname(inputPath), `${base}-out.pdf`);
          await fs.writeFile(outPath, converted);
        } catch (e) {
          // fallback copy
          await fs.copyFile(inputPath, outPath);
        }
      } else {
        // simple copy / extension change
        await fs.copyFile(inputPath, outPath);
      }

    // ---- PDF (compress) ----
    } else if (inputExt === 'pdf' || mimeType === 'application/pdf') {
      if (target !== 'pdf') {
        // user asked a different format; not supported here -> fallback copy
        await fs.copyFile(inputPath, outPath);
      } else {
        if (!commandExists('gs')) throw new Error('ghostscript (gs) not available on server');
        const tmpOut = path.join(path.dirname(inputPath), `${base}-compressed.pdf`);
        const setting = quality <= 40 ? '/screen' : (quality <= 75 ? '/ebook' : '/printer');
        await runCmd('gs', ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4',`-dPDFSETTINGS=${setting}`,'-dNOPAUSE','-dQUIET','-dBATCH',`-sOutputFile=${tmpOut}`, inputPath]);
        await fs.rename(tmpOut, outPath);
      }

    // ---- AUDIO/VIDEO ----
    } else if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      if (!commandExists('ffmpeg')) throw new Error('ffmpeg not available on server');
      const audioBR = Math.max(32, Math.floor((quality / 100) * 192));
      const videoBR = Math.max(200, Math.floor((quality / 100) * 2500));
      outPath = path.join(path.dirname(inputPath), `${base}-out.${outExt}`);
      if (mimeType.startsWith('audio/')) {
        await runCmd('ffmpeg', ['-y','-i', inputPath, '-vn', '-b:a', `${audioBR}k`, outPath]);
      } else {
        await runCmd('ffmpeg', ['-y','-i', inputPath, '-b:v', `${videoBR}k`, '-b:a', `${audioBR}k`, outPath]);
      }

    } else {
      // fallback: copy
      await fs.copyFile(inputPath, outPath);
    }

    // Verify out exists
    if (!fsSync.existsSync(outPath)) throw new Error('Output file not produced');

    // Direct download
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
    res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');

    const stream = fsSync.createReadStream(outPath);
    stream.on('end', async () => { await cleanupTmp(req); });
    stream.pipe(res);

  } catch (err) {
    console.error('filetools_v5 error:', err && err.stack ? err.stack : err);
    await cleanupTmp(req);
    return res.status(500).json({ error: 'Processing failed', detail: err && err.message ? err.message : String(err) });
  } finally {
    release();
  }
});

module.exports = router;
