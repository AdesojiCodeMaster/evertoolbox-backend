          // universal-filetool.js
// CommonJS backend for EverToolbox
// Endpoint: POST /api/tools/file (multipart/form-data field "file")
// Dependencies: express, multer, sharp, fluent-ffmpeg, pdfkit, fs-extra
// Install: npm i express multer sharp fluent-ffmpeg pdfkit fs-extra
// Ensure ffmpeg is present on the host (or set FFMPEG_PATH env var).

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const PDFDocument = require('pdfkit');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const util = require('util');

const app = express();
const unlink = util.promisify(fs.unlink);

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}
if (process.env.FFPROBE_PATH) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
}

const PORT = process.env.PORT || 3000;
const UPLOAD_FIELD = 'file';
const TMP_DIR = os.tmpdir();

// Allowed formats (5 per category)
const SUPPORTED = {
  images: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
  video: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
  documents: ['pdf', 'docx', 'txt', 'rtf', 'html']
};

// Helper: create safe random temp file path
function tmpname(ext) {
  if (!ext) ext = '';
  if (ext && !ext.startsWith('.')) ext = '.' + ext;
  return path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
}

function extFromName(name) {
  return (path.extname(name || '') || '').replace('.', '').toLowerCase();
}

function toSafeExt(e) {
  if (!e) return '';
  e = e.toLowerCase();
  if (e === 'jpeg') return 'jpg';
  return e;
}

function mimeFromExt(ext) {
  ext = ext.replace(/^\./, '').toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    rtf: 'application/rtf',
    html: 'text/html'
  };
  return map[ext] || 'application/octet-stream';
}

// Multer store to temp
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB

function log(...args) { console.log(new Date().toISOString(), ...args); }

// Detect category by extension/mimetype hint
function detectCategory(ext, mime) {
  ext = toSafeExt(ext || '');
  if (['jpg','jpeg','png','webp','gif','bmp'].includes(ext) || (mime || '').startsWith('image/')) return 'images';
  if (['mp3','wav','m4a','ogg','flac'].includes(ext) || (mime || '').startsWith('audio/')) return 'audio';
  if (['mp4','mov','mkv','avi','webm'].includes(ext) || (mime || '').startsWith('video/')) return 'video';
  if (['pdf','docx','txt','rtf','html'].includes(ext) || (mime || '').includes('pdf') || (mime || '').includes('word')) return 'documents';
  return 'unknown';
}

// Image handling using sharp
async function processImage(inputPath, targetExt, opts) {
  // targetExt: e.g. 'jpg' 'png' 'webp' 'gif' 'bmp'
  const out = tmpname('.' + targetExt);
  let img = sharp(inputPath);
  if (opts.width || opts.height) img = img.resize(opts.width ? parseInt(opts.width, 10) : null, opts.height ? parseInt(opts.height, 10) : null, { fit: 'inside' });

  const q = Math.min(Math.max(parseInt(opts.quality || 75, 10), 10), 100);

  if (targetExt === 'jpg' || targetExt === 'jpeg') {
    await img.jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toFile(out);
  } else if (targetExt === 'png') {
    // convert quality -> compression level
    const level = Math.round((100 - q) / 11);
    await img.png({ compressionLevel: Math.max(0, Math.min(9, level)) }).toFile(out);
  } else if (targetExt === 'webp') {
    await img.webp({ quality: q }).toFile(out);
  } else if (targetExt === 'gif') {
    // sharp can't write GIF. We will write PNG and then try to convert with 'convert' binary if available.
    const tmpPng = tmpname('.png');
    await img.png().toFile(tmpPng);
    try {
      const convert = spawnSync('convert', [tmpPng, out], { timeout: 20000 });
      if (convert.status === 0) {
        await fs.remove(tmpPng);
      } else {
        await fs.remove(tmpPng);
        throw new Error('ImageMagick convert failed');
      }
    } catch (e) {
      throw new Error('GIF output requires ImageMagick convert available on host');
    }
  } else if (targetExt === 'bmp') {
    await img.bmp().toFile(out);
  } else {
    // fallback: try to let sharp write with that ext
    await img.toFile(out);
  }
  return out;
}

// Audio processing using ffmpeg
function processAudio(inputPath, targetExt, opts) {
  return new Promise((resolve, reject) => {
    const out = tmpname('.' + targetExt);
    const cmd = ffmpeg(inputPath).noVideo();

    if (targetExt === 'mp3') {
      cmd.audioCodec('libmp3lame');
      if (opts.bitrate) cmd.audioBitrate(opts.bitrate);
      else cmd.audioBitrate('128k');
      cmd.format('mp3');
    } else if (targetExt === 'wav') {
      cmd.format('wav');
    } else if (targetExt === 'm4a') {
      cmd.audioCodec('aac');
      if (opts.bitrate) cmd.audioBitrate(opts.bitrate);
      cmd.format('ipod');
    } else if (targetExt === 'ogg') {
      cmd.format('ogg');
      if (opts.bitrate) cmd.audioBitrate(opts.bitrate);
    } else if (targetExt === 'flac') {
      cmd.format('flac');
    } else {
      cmd.format(targetExt);
    }

    cmd.on('error', (err) => {
      log('ffmpeg audio error', err.message);
      reject(err);
    })
    .on('end', () => resolve(out))
    .save(out);
  });
}

// Video processing using ffmpeg
function processVideo(inputPath, targetExt, opts) {
  return new Promise((resolve, reject) => {
    const out = tmpname('.' + targetExt);
    let cmd = ffmpeg(inputPath);

    // dimension resize
    if (opts.width || opts.height) {
      cmd = cmd.size(`${opts.width || '?'}x${opts.height || '?'}`);
    }

    // Choose codecs/formats by targetExt
    if (targetExt === 'mp4') {
      cmd = cmd.videoCodec('libx264').audioCodec('aac').format('mp4').outputOptions(['-preset', 'fast', '-movflags', 'faststart']);
      if (opts.crf) cmd.outputOptions(['-crf', String(opts.crf)]);
      if (opts.bitrate) cmd.videoBitrate(opts.bitrate);
    } else if (targetExt === 'mov') {
      cmd = cmd.videoCodec('libx264').audioCodec('aac').format('mov');
      if (opts.bitrate) cmd.videoBitrate(opts.bitrate);
    } else if (targetExt === 'mkv') {
      cmd = cmd.format('matroska');
      if (opts.bitrate) cmd.videoBitrate(opts.bitrate);
    } else if (targetExt === 'avi') {
      cmd = cmd.format('avi');
      if (opts.bitrate) cmd.videoBitrate(opts.bitrate);
    } else if (targetExt === 'webm') {
      cmd = cmd.videoCodec('libvpx-vp9').audioCodec('libopus').format('webm');
      if (opts.crf) cmd.outputOptions(['-crf', String(opts.crf)]);
    } else {
      cmd = cmd.videoCodec('libx264').audioCodec('aac').format('mp4');
    }

    cmd.on('error', (err) => {
      log('ffmpeg video error', err.message);
      reject(err);
    })
    .on('end', () => resolve(out))
    .save(out);
  });
}

// Document conversion: try pandoc via child_process if present; fallback: limited handling
async function processDocument(inputPath, inputExt, targetExt, opts) {
  // targetExt in ['pdf','docx','txt','rtf','html']
  const out = tmpname('.' + targetExt);

  // If input is pdf and target is image/preview, caller shouldn't request here. We only convert between docs.
  // Try pandoc: pandoc input -o output
  try {
    const pandoc = spawnSync('pandoc', [inputPath, '-o', out], { timeout: 20000 });
    if (pandoc.status === 0) {
      return out;
    }
    log('pandoc not available or failed, status:', pandoc.status);
  } catch (e) {
    log('pandoc spawn error:', e.message);
  }

  // If pandoc not available, do basic copy for compatible types
  // e.g., txt -> txt, html -> html, pdf copy
  try {
    if (inputExt === targetExt) {
      await fs.copy(inputPath, out);
      return out;
    }
    // limited fallback: if target is txt and input is anything, try to extract plain text via pdftotext or strings
    if (targetExt === 'txt') {
      // Try pdftotext
      try {
        const pdftotext = spawnSync('pdftotext', [inputPath, out], { timeout: 15000 });
        if (pdftotext.status === 0) return out;
      } catch (e) {}
      // final fallback: copy as-is and let client handle
      await fs.copy(inputPath, out);
      return out;
    }
    // as very last resort, copy file and return
    await fs.copy(inputPath, out);
    return out;
  } catch (e) {
    throw new Error('Document conversion failed: ' + e.message);
  }
}

// PDF thumbnail generator (tries pdftoppm, convert, or fallback to rendering first page via sharp if supported)
async function generatePdfThumbnail(pdfPath, outPng, size = 800) {
  try {
    const pdftoppm = spawnSync('pdftoppm', ['-png', '-f', '1', '-singlefile', '-scale-to', String(size), pdfPath, outPng.replace(/\.png$/, '')], { timeout: 10000 });
    if (pdftoppm.status === 0) return true;
  } catch (e) {}

  try {
    const convert = spawnSync('convert', [pdfPath + '[0]', '-thumbnail', `${size}x`, outPng], { timeout: 10000 });
    if (convert.status === 0) return true;
  } catch (e) {}

  // Attempt sharp fallback (requires libvips compiled with pdf support on host)
  try {
    await sharp(pdfPath, { density: 150 }).png().toFile(outPng);
    return true;
  } catch (e) {
    log('pdf thumbnail fallback failed', e.message);
  }
  return false;
}

// Main processing dispatcher
async function handleProcessing(inputPath, originalName, mimeType, params) {
  const inputExt = toSafeExt(extFromName(originalName));
  const category = detectCategory(inputExt, mimeType);
  const action = params.action || 'convert';
  const targetRaw = params.targetFormat || '';
  const targetExt = toSafeExt(targetRaw);
  const opts = {
    quality: params.quality,
    bitrate: params.bitrate,
    crf: params.crf,
    width: params.width,
    height: params.height
  };

  log('handleProcessing', { originalName, inputExt, category, action, targetExt });

  // Validation: action convert -> target required and cannot be same
  if (action === 'convert') {
    if (!targetExt) {
      const e = new Error('targetFormat is required for convert action');
      e.status = 400;
      throw e;
    }
    if (inputExt === targetExt) {
      const e = new Error('Source and target formats are the same');
      e.status = 400;
      throw e;
    }
  }

  // Routing by category
  if (category === 'images') {
    // allowed outputs: jpg/png/webp/gif/bmp (only these 5)
    if (action === 'compress' && !targetExt) {
      // compress in-place to same best format (jpg or webp) — choose jpg for simplicity
      return await processImage(inputPath, inputExt === 'png' ? 'png' : 'jpg', opts);
    }
    if (!SUPPORTED.images.includes(targetExt)) {
      const e = new Error(`Unsupported image target format: ${targetExt}`);
      e.status = 400;
      throw e;
    }
    return await processImage(inputPath, targetExt, opts);
  } else if (category === 'audio') {
    if (action === 'compress' && !targetExt) {
      // default compress -> mp3
      return await processAudio(inputPath, 'mp3', opts);
    }
    if (!SUPPORTED.audio.includes(targetExt)) {
      const e = new Error(`Unsupported audio target: ${targetExt}`);
      e.status = 400;
      throw e;
    }
    return await processAudio(inputPath, targetExt, opts);
  } else if (category === 'video') {
    if (action === 'compress' && !targetExt) {
      return await processVideo(inputPath, 'mp4', opts);
    }
    if (!SUPPORTED.video.includes(targetExt)) {
      const e = new Error(`Unsupported video target: ${targetExt}`);
      e.status = 400;
      throw e;
    }
    return await processVideo(inputPath, targetExt, opts);
  } else if (category === 'documents') {
    if (action === 'compress') {
      // Only PDF compression supported; if PDF input compress with ghostscript if present
      if (inputExt === 'pdf') {
        const outPdf = tmpname('.pdf');
        try {
          const gs = spawnSync('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dBATCH', `-sOutputFile=${outPdf}`, inputPath], { timeout: 20000 });
          if (gs.status === 0) return outPdf;
        } catch (e) {}
        // fallback: copy original
        await fs.copy(inputPath, outPdf);
        return outPdf;
      } else {
        // For non-PDF docs, attempt conversion to PDF then compress
        const converted = await processDocument(inputPath, inputExt, 'pdf', opts);
        const outPdf = tmpname('.pdf');
        try {
          const gs = spawnSync('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dBATCH', `-sOutputFile=${outPdf}`, converted], { timeout: 20000 });
          if (gs.status === 0) {
            await fs.remove(converted);
            return outPdf;
          }
        } catch (e) {}
        await fs.copy(converted, outPdf);
        await fs.remove(converted);
        return outPdf;
      }
    } else {
      // convert: requires target
      if (!targetExt) {
        const e = new Error('targetFormat required for document convert');
        e.status = 400;
        throw e;
      }
      if (!SUPPORTED.documents.includes(targetExt)) {
        const e = new Error(`Unsupported document target: ${targetExt}`);
        e.status = 400;
        throw e;
      }
      return await processDocument(inputPath, inputExt, targetExt, opts);
    }
  } else {
    // Unknown category: allow copying or attempt to use targetExt if provided
    if (action === 'convert' && targetExt) {
      const out = tmpname('.' + targetExt);
      await fs.copy(inputPath, out);
      return out;
    }
    // fallback: copy original
    const out = tmpname('.' + inputExt || '.bin');
    await fs.copy(inputPath, out);
    return out;
  }
}

// Health
app.get('/', (req, res) => res.json({ ok: true, service: 'evertoolbox-filetool', timestamp: Date.now() }));

// Main endpoint
app.post('/api/tools/file', upload.single(UPLOAD_FIELD), async (req, res) => {
  const file = req.file;
  const fields = req.body || {};
  log('incoming', { file: file ? file.originalname : null, fields });

  if (!file) return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });

  const params = {
    action: (fields.action || 'convert').toLowerCase(),
    targetFormat: (fields.targetFormat || '').toLowerCase(),
    quality: fields.quality,
    bitrate: fields.bitrate,
    crf: fields.crf,
    width: fields.width,
    height: fields.height
  };

  const inputPath = file.path;
  let outputPath = null;

  try {
    outputPath = await handleProcessing(inputPath, file.originalname, file.mimetype, params);

    // Build response headers
    const outExt = path.extname(outputPath) || path.extname(file.originalname) || '';
    const extClean = outExt.replace('.', '');
    const mime = mimeFromExt(extClean);
    // Suggest filename: original base + new ext
    const baseName = path.basename(file.originalname, path.extname(file.originalname));
    const suggestedName = baseName + (outExt || '');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${suggestedName}"`);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on('close', async () => {
      try {
        await fs.remove(outputPath).catch(() => {});
        await fs.remove(inputPath).catch(() => {});
        log('cleaned temp files for', file.originalname);
      } catch (e) {
        log('cleanup error', e.message);
      }
    });

  } catch (err) {
    log('processing-error', err.message || err);
    await fs.remove(inputPath).catch(() => {});
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'Processing failed' });
  }
});


