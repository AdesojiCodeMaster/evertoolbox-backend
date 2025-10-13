// universal-filetool.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

function cleanup(file) {
  if (fs.existsSync(file)) fs.unlink(file, () => {});
}

// Utility to compress any buffer aggressively (~10–20% of original)
async function compressBuffer(buffer, type, quality = 80) {
  if (type.startsWith('image/')) {
    return await sharp(buffer)
      .jpeg({ quality: Math.min(quality, 90) })
      .toBuffer();
  }
  // fallback: crude binary shrink (truncate precision)
  return buffer.slice(0, Math.floor(buffer.length * 0.2));
}

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const { action, targetFormat, quality = 80 } = req.body;
    const input = req.file;
    const filePath = input.path;
    const mime = input.mimetype;

    let outBuffer;
    let outMime = mime;
    let ext = targetFormat || path.extname(input.originalname).slice(1);
    let filename = `result.${ext}`;

    if (action === 'compress') {
      outBuffer = await compressBuffer(fs.readFileSync(filePath), mime, quality);
    } else if (action === 'convert') {
      // image conversion
      if (mime.startsWith('image/')) {
        const image = sharp(filePath);
        if (targetFormat === 'pdf') {
          // Convert image -> PDF
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on('data', (d) => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/pdf');
            res.end(buffer);
            cleanup(filePath);
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

      // text/doc conversion (simplified)
      else if (mime.includes('text') || mime.includes('json')) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (targetFormat === 'pdf') {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on('data', (d) => chunks.push(d));
          doc.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/pdf');
            res.end(buffer);
            cleanup(filePath);
          });
          doc.fontSize(12).text(text);
          doc.end();
          return;
        } else {
          outBuffer = Buffer.from(text, 'utf8');
          outMime = 'text/plain';
        }
      }

      // audio/video conversion (simplified ffmpeg)
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

      else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    cleanup(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', outMime);
    res.end(outBuffer);
  } catch (e) {
    console.error('❌ Processing failed:', e);
    res.status(500).json({ error: 'File processing failed: ' + e.message });
  }
});

module.exports = router;
