// universal-filetool.js (final, replace existing)
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const router = express.Router();

// multer temp uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit
});

// safe unlink
function safeUnlink(p) {
  if (!p) return;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
}

// helper: send JSON error and log
function respondError(res, status, message, err) {
  console.error(message, err || '');
  return res.status(status).json({ error: String(message) + (err ? ' — ' + (err.message || err) : '') });
}

// helper: stream file and cleanup after finished/closed
function streamFile(res, filepath, outName, mime) {
  if (!fs.existsSync(filepath)) return respondError(res, 500, 'Output file missing');
  try {
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    const s = fs.createReadStream(filepath);
    s.on('error', (e) => {
      safeUnlink(filepath);
      try { res.end(); } catch (e2) {}
    });
    s.pipe(res);
    s.on('close', () => {
      safeUnlink(filepath);
    });
  } catch (e) {
    safeUnlink(filepath);
    return respondError(res, 500, 'Failed streaming file', e);
  }
}

// helper to run ffmpeg as a promise and gather stderr for better errors
function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    cmd.on('stderr', (line) => { stderr += line + '\n'; });
    cmd.on('end', () => resolve({ success: true }));
    cmd.on('error', (err) => reject(new Error(stderr || err.message || 'ffmpeg error')));
    cmd.run();
  });
}

router.post('/process', upload.single('file'), async (req, res) => {
  if (!req.file) return respondError(res, 400, 'No file uploaded');

  const action = (req.body.action || '').toLowerCase();
  const targetFormat = (req.body.targetFormat || '').toLowerCase();
  const quality = Math.max(10, Math.min(100, parseInt(req.body.quality) || 80));

  const inPath = req.file.path;
  const origName = req.file.originalname || 'file';
  const mime = req.file.mimetype || '';
  const origExt = path.extname(origName).replace(/^\./, '').toLowerCase() || '';

  try {
    // Validation
    if (!action) return respondError(res, 400, 'Action required (convert or compress)');
    if (action === 'convert' && !targetFormat) return respondError(res, 400, 'Target format required for conversion');
    if (action === 'convert' && targetFormat === origExt) return respondError(res, 400, 'Source and target formats are the same');

    // output naming
    const outExt = (action === 'compress' && origExt) ? origExt : (targetFormat || origExt || 'bin');
    const baseOutName = path.basename(origName, path.extname(origName));
    const outFilename = `${baseOutName}.${outExt}`;
    const outPath = `${inPath}_out.${outExt}`;

    // -------- IMAGE --------
    if (mime.startsWith('image/')) {
      try {
        const img = sharp(inPath);
        if (action === 'compress') {
          // try to keep same format where possible, otherwise use jpeg
          const fmt = (origExt === 'png' || origExt === 'webp') ? origExt : 'jpeg';
          await img.toFormat(fmt, { quality: Math.min(quality, 90) }).toFile(outPath);
          const mimeOut = fmt === 'jpeg' ? 'image/jpeg' : `image/${fmt}`;
          return streamFile(res, outPath, outFilename, mimeOut);
        } else {
          if (targetFormat === 'pdf') {
            const meta = await img.metadata();
            const doc = new PDFDocument({ autoFirstPage: false });
            const ws = fs.createWriteStream(outPath);
            doc.pipe(ws);
            doc.addPage({ size: [meta.width || 612, meta.height || 792] });
            const buf = await img.jpeg({ quality: Math.min(quality, 90) }).toBuffer();
            doc.image(buf, 0, 0, { width: meta.width || 612, height: meta.height || 792 });
            doc.end();
            await new Promise((resolve, reject) => ws.on('finish', resolve).on('error', reject));
            return streamFile(res, outPath, outFilename, 'application/pdf');
          } else {
            await img.toFormat(targetFormat, { quality: Math.min(quality, 90) }).toFile(outPath);
            return streamFile(res, outPath, outFilename, `image/${targetFormat}`);
          }
        }
      } catch (e) {
        safeUnlink(inPath);
        return respondError(res, 500, 'Image processing failed', e);
      }
    }

    // -------- TEXT / HTML --------
    if (mime.includes('text') || mime.includes('html')) {
      try {
        const txt = fs.readFileSync(inPath, 'utf8');
        if (action === 'convert' && targetFormat === 'pdf') {
          const doc = new PDFDocument();
          const ws = fs.createWriteStream(outPath);
          doc.pipe(ws);
          doc.fontSize(12).text(txt);
          doc.end();
          await new Promise((resolve, reject) => ws.on('finish', resolve).on('error', reject));
          return streamFile(res, outPath, outFilename, 'application/pdf');
        } else {
          fs.writeFileSync(outPath, txt, 'utf8');
          return streamFile(res, outPath, outFilename, 'text/plain');
        }
      } catch (e) {
        safeUnlink(inPath);
        return respondError(res, 500, 'Text/doc processing failed', e);
      }
    }

    // -------- AUDIO --------
    if (mime.startsWith('audio/')) {
      try {
        // We'll preserve full duration by only re-encoding audio codec/bitrate
        // Choose output extension
        const extOut = action === 'compress' ? (origExt || 'mp3') : (targetFormat || origExt || 'mp3');
        const outFile = outPath;

        // Build ffmpeg command
        let cmd = ffmpeg(inPath).audioCodec('libmp3lame');
        if (action === 'compress') {
          // map quality -> bitrate: 32-192 kbps
          const bitrate = Math.max(32, Math.floor((quality / 100) * 192));
          cmd = cmd.audioBitrate(`${bitrate}k`);
          cmd = cmd.format(extOut);
        } else {
          // convert: set format and bitrate
          const bitrate = Math.max(64, Math.floor((quality / 100) * 256));
          cmd = cmd.audioBitrate(`${bitrate}k`).format(extOut);
        }
        cmd = cmd.output(outFile);

        // collect stderr for diagnostics
        await runFFmpeg(cmd);
        const mimeOut = `audio/${extOut === 'mp3' ? 'mpeg' : extOut}`;
        return streamFile(res, outFile, outFilename, mimeOut);
      } catch (e) {
        safeUnlink(inPath);
        return respondError(res, 500, 'Audio processing failed', e);
      }
    }

    // -------- VIDEO --------
    if (mime.startsWith('video/')) {
      try {
        const extOut = action === 'compress' ? (origExt || 'mp4') : (targetFormat || origExt || 'mp4');
        const outFile = outPath;

        // Build ffmpeg command for video
        let cmd = ffmpeg(inPath);

        if (action === 'compress') {
          // Map quality to CRF (higher quality -> lower CRF)
          const q = Math.max(10, Math.min(100, quality));
          const crf = Math.round(28 - ((q - 10) / 90) * 10); // 10->28, 100->18 roughly
          // preserve duration; re-encode video with libx264, cap height to 720 to reduce size
          cmd = cmd.videoCodec('libx264')
                   .outputOptions(['-preset medium', `-crf ${crf}`, '-movflags +faststart'])
                   .audioCodec('aac')
                   .audioBitrate('128k')
                   .size('?x720');
          cmd = cmd.output(outFile);
        } else {
          // convert: use requested container/codec; default to h264/aac
          if (extOut === 'webm') {
            cmd = cmd.videoCodec('libvpx-vp9').audioCodec('libopus').outputOptions(['-crf 33', '-b:v 0']);
          } else {
            cmd = cmd.videoCodec('libx264').audioCodec('aac').outputOptions(['-preset medium', '-crf 23']).size('?x720');
          }
          cmd = cmd.format(extOut).output(outFile);
        }

        await runFFmpeg(cmd);
        const mimeOut = `video/${extOut}`;
        return streamFile(res, outFile, outFilename, mimeOut);
      } catch (e) {
        safeUnlink(inPath);
        return respondError(res, 500, 'Video processing failed', e);
      }
    }

    // -------- FALLBACK: return original file ----------
    return streamFile(res, inPath, outFilename, mime);
  } catch (err) {
    console.error('Unexpected error:', err);
    safeUnlink(inPath);
    return respondError(res, 500, 'Unexpected processing error', err);
  }
});

module.exports = router;
    
