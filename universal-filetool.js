// universal-filetool.js
// CommonJS router compatible with server.js that requires it.
// Requires: express, multer, sharp, fluent-ffmpeg, pdfkit, mime-types, fs, path

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Ensure directories exist
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('jobs')) fs.mkdirSync('jobs');

// Helper: safe cleanup
function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
}

// Helper: map extension to mime (fallback)
const mimeMap = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', html: 'text/html',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo'
};

// Health
router.get('/health', (req, res) => res.json({ ok: true }));

// Main endpoint expected by the UI: POST /process
router.post('/process', upload.single('file'), async (req, res) => {
  // Immediately validate
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const action = (req.body.action || '').toLowerCase();
  const targetFormat = (req.body.targetFormat || '').toLowerCase();
  const quality = Math.min(100, Math.max(10, parseInt(req.body.quality || '80')));

  const input = req.file;
  const inputPath = input.path;
  const inputMime = input.mimetype || mime.lookup(input.originalname) || 'application/octet-stream';
  const inputExt = (path.extname(input.originalname) || '').replace('.', '').toLowerCase();
  const baseName = path.basename(input.originalname, path.extname(input.originalname));

  try {
    if (!action || !['convert', 'compress'].includes(action)) {
      safeUnlink(inputPath);
      return res.status(400).json({ error: 'Invalid or missing action (convert/compress).' });
    }

    // Block avif entirely
    if (targetFormat === 'avif' || inputExt === 'avif' || inputMime === 'image/avif') {
      safeUnlink(inputPath);
      return res.status(400).json({ error: 'AVIF is not supported.' });
    }

    // Prepare variables for output
    let outBuffer = null;
    let outPath = null;
    let outExt = '';
    let outMime = '';

    // ----------------------------
    // COMPRESSION
    // ----------------------------
    if (action === 'compress') {
      // Image compression: always re-encode to reduce size reliably
      if (inputMime.startsWith('image/')) {
        const img = sharp(inputPath);
        const meta = await img.metadata();

        if (meta.hasAlpha) {
          // keep transparency -> webp for better compression
          outExt = 'webp';
          const buf = await img.webp({ quality: Math.max(30, Math.min(quality, 85)) }).toBuffer();
          outBuffer = buf; outMime = mimeMap[outExt] || 'image/webp';
        } else {
          // no alpha -> jpeg
          outExt = 'jpg';
          const buf = await img.jpeg({ quality: Math.max(30, Math.min(quality, 90)), mozjpeg: true }).toBuffer();
          outBuffer = buf; outMime = 'image/jpeg';
        }
      }

      // Audio/Video compression via ffmpeg -> mp3/mp4
      else if (inputMime.startsWith('audio/') || inputMime.startsWith('video/')) {
        outExt = inputMime.startsWith('audio/') ? 'mp3' : 'mp4';
        outPath = path.join('jobs', `${baseName}_compressed.${outExt}`);
        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(inputPath)
            .audioBitrate('128k')
            .outputOptions(['-preset ultrafast', '-movflags +faststart']);
          if (inputMime.startsWith('video/')) {
            cmd = cmd.videoBitrate('800k');
          }
          cmd.on('end', resolve).on('error', reject).save(outPath);
        });
        outBuffer = fs.readFileSync(outPath);
        outMime = mimeMap[outExt] || mime.lookup(outExt) || 'application/octet-stream';
        safeUnlink(outPath);
      } else {
        // fallback: copy
        outExt = inputExt || 'bin';
        outBuffer = fs.readFileSync(inputPath);
        outMime = inputMime;
      }

      // Final filename
      const filename = `${baseName}_compressed.${outExt || inputExt}`;
      // send buffer
      res.setHeader('Content-Type', outMime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(outBuffer, () => safeUnlink(inputPath));
      return;
    }

    // ----------------------------
    // CONVERSION
    // ----------------------------
    if (action === 'convert') {
      if (!targetFormat) {
        safeUnlink(inputPath);
        return res.status(400).json({ error: 'Please select a target format for conversion.' });
      }
      if (targetFormat === inputExt) {
        safeUnlink(inputPath);
        return res.status(400).json({ error: 'Source and target formats cannot be the same.' });
      }

      // IMAGE -> PDF
      if (inputMime.startsWith('image/')) {
        if (targetFormat === 'pdf') {
          const image = sharp(inputPath);
          const meta = await image.metadata();
          const imgBuf = await image.jpeg({ quality: Math.max(70, Math.min(quality, 95)) }).toBuffer();

          // create PDF with pdfkit
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on('data', (c) => chunks.push(c));
          doc.on('end', () => {
            const pdfBuf = Buffer.concat(chunks);
            const filename = `${baseName}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.end(pdfBuf, () => safeUnlink(inputPath));
          });
          doc.addPage({ size: [meta.width, meta.height] });
          doc.image(imgBuf, 0, 0, { width: meta.width, height: meta.height });
          doc.end();
          return;
        } else {
          // image -> image (jpeg/png/webp)
          const fmt = targetFormat === 'jpg' ? 'jpeg' : targetFormat;
          const buf = await sharp(inputPath).toFormat(fmt, { quality: Math.max(60, Math.min(quality, 95)) }).toBuffer();
          outBuffer = buf;
          outExt = (fmt === 'jpeg' ? 'jpg' : fmt);
          outMime = mimeMap[outExt] || `image/${outExt}`;
        }
      }

      // PDF -> image / txt / html
      else if (inputMime === 'application/pdf') {
        // PDF -> image (first page)
        if (['png', 'jpg', 'jpeg', 'webp'].includes(targetFormat)) {
          outExt = (targetFormat === 'jpeg') ? 'jpg' : targetFormat;
          outPath = path.join('jobs', `${baseName}_page1.${outExt}`);

          // Use ffmpeg to extract first page as image
          await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
              .outputOptions(['-frames:v 1'])
              .output(outPath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });

          // if ffmpeg produced a file
          if (!fs.existsSync(outPath)) throw new Error('PDF to image conversion failed.');
          outBuffer = fs.readFileSync(outPath);
          outMime = mimeMap[outExt] || `image/${outExt}`;
          safeUnlink(outPath);
        }

        // PDF -> txt/html (simple extract fallback)
        else if (targetFormat === 'txt' || targetFormat === 'html') {
          // We will do a best-effort: use external poppler pdftotext if available, else fallback to a simple message
          const txtPath = path.join('jobs', `${baseName}.txt`);
          // Try pdftotext cli if available
          const { exec } = require('child_process');
          try {
            await new Promise((resolve, reject) => {
              exec(`pdftotext "${inputPath}" "${txtPath}"`, (err) => {
                if (err) return reject(err);
                resolve();
              });
            });
            const txt = fs.readFileSync(txtPath, 'utf8');
            outBuffer = Buffer.from(txt, 'utf8');
            outMime = targetFormat === 'txt' ? 'text/plain' : 'text/html';
            safeUnlink(txtPath);
          } catch (e) {
            // Fallback: short placeholder because OCR isn't available here
            const fallback = 'PDF text extraction is not available in this environment.';
            outBuffer = Buffer.from(fallback, 'utf8');
            outMime = targetFormat === 'txt' ? 'text/plain' : 'text/html';
          }
        }

        // PDF -> PDF (copy)
        else if (targetFormat === 'pdf') {
          outBuffer = fs.readFileSync(inputPath);
          outExt = 'pdf';
          outMime = 'application/pdf';
        } else {
          throw new Error('Unsupported PDF conversion target.');
        }
      }

      // Audio/Video -> conversion
      else if (inputMime.startsWith('audio/') || inputMime.startsWith('video/')) {
        outExt = targetFormat || (inputMime.startsWith('audio/') ? 'mp3' : 'mp4');
        outPath = path.join('jobs', `${baseName}_converted.${outExt}`);

        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(inputPath).output(outPath).outputOptions(['-preset superfast', '-movflags +faststart']);
          // set reasonable bitrates
          if (inputMime.startsWith('video/')) cmd = cmd.videoBitrate('800k').audioBitrate('128k');
          else cmd = cmd.audioBitrate('128k');

          cmd.on('end', resolve).on('error', reject).run();
        });

        outBuffer = fs.readFileSync(outPath);
        outMime = mimeMap[outExt] || mime.lookup(outExt) || (inputMime.startsWith('audio/') ? `audio/${outExt}` : `video/${outExt}`);
        safeUnlink(outPath);
      }

      // Text/HTML -> PDF or plain
      else if (inputMime.startsWith('text/') || inputMime.includes('json') || inputMime.includes('html')) {
        const txt = fs.readFileSync(inputPath, 'utf8');
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on('data', (c) => chunks.push(c));
          doc.on('end', () => {
            const pdfBuf = Buffer.concat(chunks);
            const filename = `${baseName}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.end(pdfBuf, () => safeUnlink(inputPath));
          });
          doc.fontSize(12).text(txt);
          doc.end();
          return;
        } else {
          outBuffer = Buffer.from(txt, 'utf8');
          outExt = targetFormat || 'txt';
          outMime = mimeMap[outExt] || 'text/plain';
        }
      }

      // fallback: copy
      else {
        outBuffer = fs.readFileSync(inputPath);
        outExt = targetFormat || inputExt;
        outMime = mime.lookup(outExt) || inputMime || 'application/octet-stream';
      }

      // Build filename (converted)
      if (!outExt) {
        // if we didn't set outExt earlier, try derive from targetFormat or inputExt
        outExt = targetFormat || inputExt || 'bin';
      }
      const filename = `${baseName}_converted.${outExt}`;

      // send buffer
      res.setHeader('Content-Type', outMime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(outBuffer, () => safeUnlink(inputPath));
      return;
    }

    // Should not reach here
    safeUnlink(inputPath);
    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Processing error:', err);
    safeUnlink(inputPath);
    // Return JSON error for frontend to parse
    return res.status(500).json({ error: err.message || 'Processing error' });
  }
});

module.exports = router;
  
