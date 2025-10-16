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

// Smart compression
async function compressBuffer(buffer, type, quality = 70) {
  if (type.startsWith('image/')) {
    return await sharp(buffer).jpeg({ quality: Math.min(quality, 85) }).toBuffer();
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

    if (!action) return res.status(400).json({ error: "Missing action (convert/compress)." });

    // 🗜️ COMPRESSION
    if (action === 'compress') {
      if (mime.startsWith('image/')) {
        outBuffer = await compressBuffer(fs.readFileSync(filePath), mime, quality);
      } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        const outPath = `${filePath}_compressed.${mime.startsWith('audio/') ? 'mp3' : 'mp4'}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .audioBitrate('128k')
            .videoBitrate('800k')
            .outputOptions('-preset ultrafast')
            .on('end', resolve)
            .on('error', reject)
            .save(outPath);
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
      } else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    // 🔄 CONVERSION
    else if (action === 'convert') {
      if (!targetFormat) return res.status(400).json({ error: "Missing target format." });
      if (targetFormat === originalExt) return res.status(400).json({ error: "Source and target formats are the same." });

      // 🖼️ Image Conversion
      if (mime.startsWith('image/')) {
        const image = sharp(filePath);

        // → PDF
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on('data', d => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="result.pdf"');
            res.end(buffer, () => cleanup(filePath));
          });
          const { width, height } = await image.metadata();
          const imgBuffer = await image.jpeg({ quality: 90 }).toBuffer();
          doc.addPage({ size: [width, height] });
          doc.image(imgBuffer, 0, 0, { width, height });
          doc.end();
          return;
        }

        // → Image
        const valid = ['jpeg', 'jpg', 'png', 'webp', 'tiff', 'gif'];
        if (!valid.includes(targetFormat)) throw new Error(`Unsupported target format: ${targetFormat}`);
        outBuffer = await image.toFormat(targetFormat, { quality: +quality }).toBuffer();
        outMime = `image/${targetFormat}`;
      }

      // 📄 Text/HTML → Anything
      else if (mime.includes('text') || mime.includes('json') || mime.includes('html')) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on('data', d => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="result.pdf"');
            res.end(buffer, () => cleanup(filePath));
          });
          doc.fontSize(12).text(text);
          doc.end();
          return;
        }
        outBuffer = Buffer.from(text, 'utf8');
        outMime = 'text/plain';
      }

      // 🎧 Audio/🎬 Video Conversion
      else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        const outPath = `${filePath}.${targetFormat}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .output(outPath)
            .outputOptions('-preset ultrafast')
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
        outMime = mime.startsWith('audio/') ? `audio/${targetFormat}` : `video/${targetFormat}`;
      }

      else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(outBuffer, () => cleanup(filePath));

  } catch (e) {
    console.error('❌ Processing failed:', e);
    res.status(500).json({ error: 'Processing error: ' + e.message });
  }
});

module.exports = router;
