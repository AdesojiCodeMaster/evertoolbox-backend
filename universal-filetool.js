// universal-filetool.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const router = express.Router();
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
const upload = multer({ dest: 'uploads/' });

function cleanup(file) {
  if (fs.existsSync(file)) fs.unlink(file, () => {});
}

// Smart image compression
async function compressBuffer(buffer, type, quality = 80) {
  if (type.startsWith('image/')) {
    return await sharp(buffer)
      .jpeg({ quality: Math.min(quality, 90) })
      .toBuffer();
  }
  return buffer;
}

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const { action, targetFormat, quality = 80 } = req.body;
    const input = req.file;
    const filePath = input.path;
    const mime = input.mimetype;
    const originalExt = path.extname(input.originalname).slice(1);

    let outBuffer, outMime = mime;
    let ext = targetFormat || originalExt;
    let filename = `result.${ext}`;

    // Validation
    if (!action) return res.status(400).json({ error: "Please select an action (convert or compress)." });
    if (action === 'convert' && !targetFormat)
      return res.status(400).json({ error: "Please select a target format for conversion." });
    if (action === 'convert' && targetFormat === originalExt)
      return res.status(400).json({ error: "Source and target formats cannot be the same." });

    // Image compression
    if (action === 'compress' && mime.startsWith('image/')) {
      outBuffer = await compressBuffer(fs.readFileSync(filePath), mime, quality);
      outMime = mime;
    }

    // Audio/Video compression
    else if (action === 'compress' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
      const outPath = `${filePath}_compressed.${mime.startsWith('audio/') ? 'mp3' : 'mp4'}`;
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .audioBitrate('128k')
          .videoBitrate('800k')
          .outputOptions('-preset veryfast')
          .on('end', resolve)
          .on('error', reject)
          .save(outPath);
      });
      outBuffer = fs.readFileSync(outPath);
      cleanup(outPath);
      outMime = mime;
    }

    // Conversion
    else if (action === 'convert') {
      // Image conversion
      if (mime.startsWith('image/')) {
        const image = sharp(filePath);
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on('data', (d) => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.end(buffer, () => cleanup(filePath)); // ✅ cleanup after send
          });
          const { width, height } = await image.metadata();
          doc.addPage({ size: [width, height] });
          const imgBuffer = await image.jpeg({ quality: 90 }).toBuffer();
          doc.image(imgBuffer, 0, 0, { width, height });
          doc.end();
          return;
        } else {
          outBuffer = await image.toFormat(targetFormat, { quality: +quality }).toBuffer();
          outMime = `image/${targetFormat}`;
        }
      }

      // Document/text conversion
      else if (mime.includes('text') || mime.includes('json') || mime.includes('html')) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on('data', (d) => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.end(buffer, () => cleanup(filePath)); // ✅ cleanup after send
          });
          doc.fontSize(12).text(text);
          doc.end();
          return;
        } else {
          outBuffer = Buffer.from(text, 'utf8');
          outMime = 'text/plain';
        }
      }

      // Audio/video conversion
      else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        const outPath = `${filePath}.${targetFormat}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
        outMime = mime.startsWith('audio/') ? `audio/${targetFormat}` : `video/${targetFormat}`;
      }

      // Fallback
      else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(outBuffer, () => cleanup(filePath)); // ✅ cleanup after send

  } catch (e) {
    console.error('❌ Processing failed:', e); // ✅ fixed
    res.status(500).json({ error: 'File processing failed: ' + e.message });
  }
});

module.exports = router;
                         
