// universal-filetool.js (final)
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const router = express.Router();

// Increase upload limit; temp upload folder
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit (adjust if needed)
});

// safe cleanup
function safeUnlink(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
}

// Helper to send an error JSON with logging
function fail(res, code, message, err) {
  console.error(message, err || '');
  return res.status(code).json({ error: message + (err ? ': ' + (err.message || err) : '') });
}

// For streaming responses, set headers and send file via res.download (handles ranges etc.)
async function sendFile(res, filepath, outName, mime) {
  if (!fs.existsSync(filepath)) return fail(res, 500, 'Output file missing');
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  // recommend Content-Disposition so frontend can extract filename
  res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
  // stream and cleanup after close
  const stream = fs.createReadStream(filepath);
  stream.on('error', (e) => {
    safeUnlink(filepath);
    console.error('Stream error', e);
    try { res.end(); } catch (_) {}
  });
  stream.pipe(res);
  stream.on('close', () => {
    safeUnlink(filepath);
  });
}

// endpoint
router.post('/process', upload.single('file'), async (req, res) => {
  if (!req.file) return fail(res, 400, 'No file uploaded');

  const action = (req.body.action || '').toLowerCase();
  const targetFormat = (req.body.targetFormat || '').toLowerCase();
  const quality = Math.max(10, Math.min(100, parseInt(req.body.quality) || 80));

  const inFile = req.file.path;
  const originalName = req.file.originalname || 'input';
  const mime = req.file.mimetype || '';
  const originalExt = path.extname(originalName).replace(/^\./, '') || '';
  const effectiveTarget = targetFormat || originalExt || 'bin';

  try {
    // validation
    if (!action) return fail(res, 400, 'Action required (convert or compress)');
    if (action === 'convert' && !targetFormat) return fail(res, 400, 'Please select a target format for conversion');
    if (action === 'convert' && targetFormat === originalExt) return fail(res, 400, 'Source and target formats are the same');

    // prepare output path and name
    const outExt = (action === 'compress' && originalExt) ? originalExt : (targetFormat || originalExt);
    const outFilename = `${path.basename(originalName, path.extname(originalName))}.${outExt}`;
    const outPath = `${inFile}_out.${outExt}`;

    // ---------- IMAGES ----------
    if (mime.startsWith('image/')) {
      if (action === 'compress') {
        // compress image but don't upsize; use jpeg by default if incoming format not supported
        const image = sharp(inFile);
        const meta = await image.metadata();
        // choose output format same as original if possible
        const fmt = originalExt === 'png' ? 'png' : (originalExt === 'webp' ? 'webp' : 'jpeg');
        await image.toFormat(fmt, { quality: Math.min(quality, 90) }).toFile(outPath);
        await sendFile(res, outPath, outFilename, `image/${fmt}`);
        return;
      } else {
        // convert. special-case pdf target
        if (targetFormat === 'pdf') {
          const image = sharp(inFile);
          const meta = await image.metadata();
          const doc = new PDFDocument({ autoFirstPage: false });
          // write PDF to file stream
          const writer = fs.createWriteStream(outPath);
          doc.pipe(writer);
          doc.addPage({ size: [meta.width || 612, meta.height || 792] });
          const buf = await image.jpeg({ quality: Math.min(quality, 90) }).toBuffer();
          doc.image(buf, 0, 0, { width: meta.width || 612, height: meta.height || 792 });
          doc.end();
          await new Promise((resolve, reject) => writer.on('finish', resolve).on('error', reject));
          await sendFile(res, outPath, outFilename, 'application/pdf');
          return;
        } else {
          // normal image conversion
          const image = sharp(inFile);
          await image.toFormat(targetFormat, { quality: Math.min(quality, 90) }).toFile(outPath);
          await sendFile(res, outPath, outFilename, `image/${targetFormat}`);
          return;
        }
      }
    }

    // ---------- TEXT / HTML ----------
    if (mime.includes('text') || mime.includes('html')) {
      const txt = fs.readFileSync(inFile, 'utf8');
      if (action === 'convert' && targetFormat === 'pdf') {
        const doc = new PDFDocument();
        const writer = fs.createWriteStream(outPath);
        doc.pipe(writer);
        doc.fontSize(12).text(txt);
        doc.end();
        await new Promise((resolve, reject) => writer.on('finish', resolve).on('error', reject));
        await sendFile(res, outPath, outFilename, 'application/pdf');
        return;
      } else {
        fs.writeFileSync(outPath, txt, 'utf8');
        await sendFile(res, outPath, outFilename, 'text/plain');
        return;
      }
    }

    // ---------- AUDIO ----------
    if (mime.startsWith('audio/')) {
      // Use ffmpeg to re-encode audio while preserving duration and metadata
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(inFile).audioCodec('libmp3lame');

        // if compress -> lower bitrate; if convert -> target format sets container
        if (action === 'compress') {
          // choose a safe bitrate map based on quality
          const bitrate = Math.max(32, Math.floor((quality / 100) * 192)); // 32 - 192 kbps
          cmd.audioBitrate(`${bitrate}k`);
          // produce mp3 output unless original extension requested to be preserved
          const extOut = originalExt || 'mp3';
          cmd.format(extOut);
          cmd.output(outPath);
        } else if (action === 'convert') {
          // convert to requested container
          cmd.format(targetFormat);
          // set reasonable bitrate
          const bitrate = Math.max(64, Math.floor((quality / 100) * 256));
          cmd.audioBitrate(`${bitrate}k`);
          cmd.output(outPath);
        }

        // ensure we don't trim — do not set duration options
        cmd.on('end', resolve).on('error', reject).run();
      });

      // safe: detect mime for returned container
      const returnedMime = `audio/${outExtFromPath(outPath) || 'mpeg'}`;
      await sendFile(res, outPath, outFilename, returnedMime);
      return;
    }

    // ---------- VIDEO ----------
    if (mime.startsWith('video/')) {
      // Video: re-encode with libx264 (H.264), preserve fps/duration; CRF to reduce size
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(inFile);

        if (action === 'compress') {
          // compress: re-encode h264 with CRF for quality-size tradeoff
          // CRF: lower -> better quality; 23-28 range is reasonable. We'll map quality(10-100) -> crf 28->18
          // higher quality value (=closer to 100) -> lower crf number -> higher quality
          const q = Math.max(10, Math.min(100, quality));
          const crf = Math.round(28 - ((q - 10) / 90) * 10); // maps 10->28, 100->18 roughly
          cmd.videoCodec('libx264')
             .videoBitrate(undefined) // let CRF control size
             .outputOptions(['-preset medium', `-crf ${crf}`, '-movflags +faststart'])
             .audioCodec('aac')
             .audioBitrate('128k')
             .size('?x720'); // cap height to 720 to reduce size for large inputs
          cmd.output(outPath);
        } else if (action === 'convert') {
          // conversion: change container/codec if requested
          // If target is webm -> use libvpx-vp9 if available; otherwise use ffmpeg to set container
          if (targetFormat === 'webm') {
            cmd.videoCodec('libvpx-vp9')
               .audioCodec('libopus')
               .outputOptions(['-b:v 0', '-crf 33']); // vp9 variable bit-rate/crf
          } else {
            // default convert to mp4/h264+aac
            cmd.videoCodec('libx264').audioCodec('aac').outputOptions(['-preset medium', '-crf 23']).size('?x720');
          }
          cmd.format(targetFormat);
          cmd.output(outPath);
        }

        // run
        cmd.on('end', resolve).on('error', reject).run();
      });

      const returnedMime = `video/${outExtFromPath(outPath) || 'mp4'}`;
      await sendFile(res, outPath, outFilename, returnedMime);
      return;
    }

    // ---------- fallback: return original file ----------
    await sendFile(res, inFile, outFilename, mime);

  } catch (err) {
    console.error('Processing failed:', err);
    safeUnlink(inFile);
    // cleanup any out files that may exist
    try { fs.readdirSync(path.dirname(inFile)).forEach(f => { if (f.includes(path.basename(inFile))) safeUnlink(path.join(path.dirname(inFile), f)); }); } catch(e){}
    return fail(res, 500, 'Processing failed: ' + (err.message || err));
  }
});

// helper to get extension from outPath
function outExtFromPath(p) {
  try {
    return path.extname(p).replace('.', '').toLowerCase();
  } catch (e) { return ''; }
}

module.exports = router;
