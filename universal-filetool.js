// universal-filetool.js
// Improved universal file tool for Render deployment
// - Handles conversion + compression
// - Keeps temp cleanup AFTER response
// - Uses ffmpeg (video/audio) and sharp (images). Falls back for PDF images to pdftoppm if available.

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const PDFParser = require('pdf-parse'); // for extracting text
const { Document, Packer, Paragraph, TextRun } = require('docx'); // create simple docx
const PDFDocument = require('pdfkit');

const router = express.Router();
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
const upload = multer({ dest: 'uploads/' });

function cleanup(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) { /* ignore */ }
}

function safeName(original, suffix, ext) {
  const base = path.basename(original, path.extname(original));
  return `${base}${suffix}.${ext}`;
}

async function compressImageBuffer(buffer, mime, quality = 70) {
  // aggressive for small files, conservative for large
  const q = Math.min(Math.max(parseInt(quality, 10) || 70, 30), 90);
  if (mime.includes('png')) {
    // convert PNG -> JPEG for stronger size reduction if acceptable
    return { buffer: await sharp(buffer).jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
  }
  if (mime.includes('webp')) {
    return { buffer: await sharp(buffer).jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
  }
  // default: re-encode JPEG or other image types
  return { buffer: await sharp(buffer).jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
}

async function pdfFirstPageToImage(filePath, outPath) {
  // Try using sharp (works if libvips/poppler available)
  try {
    // sharp can read PDFs if built with pdf support; try first
    await sharp(filePath, { density: 150 }).png().toFile(outPath);
    return true;
  } catch (e) {
    // fallback to pdftoppm (poppler) if available
    return new Promise((resolve) => {
      const pdftoppm = 'pdftoppm';
      if (fs.existsSync('/usr/bin/pdftoppm') || fs.existsSync('/usr/local/bin/pdftoppm')) {
        // use pdftoppm
        const args = ['-f', '1', '-singlefile', '-png', filePath, outPath.replace(/\.png$/, '')];
        execFile(pdftoppm, args, (err) => {
          resolve(!err && fs.existsSync(outPath));
        });
      } else {
        // try running pdftoppm from PATH
        execFile(pdftoppm, args || [], (err) => {
          resolve(!err && fs.existsSync(outPath));
        });
      }
    });
  }
}

router.get('/health', (req, res) => res.json({ ok: true }));

// Main process route
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    // Basic validation
    const { action = 'convert', targetFormat = '', quality = 80 } = req.body || {};
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });

    const filePath = file.path;
    const mime = file.mimetype || 'application/octet-stream';
    const originalName = file.originalname;
    const originalExt = path.extname(originalName).slice(1).toLowerCase();

    // sanitize chosen ext: remove avif if given
    let chosenFormat = (targetFormat || '').toLowerCase();
    if (chosenFormat === 'avif') {
      chosenFormat = ''; // force fallback
    }

    // prepare output naming
    const outSuffix = action === 'compress' ? '_compressed' : '_converted';
    let outExt = chosenFormat || originalExt;
    if (action === 'compress' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
      // keep same extension for audio/video compress unless converting
      outExt = originalExt;
    }

    // result buffers and mime
    let outBuffer = null;
    let outMime = mime;
    let outFilename = safeName(originalName, outSuffix, outExt);

    // ACTION: COMPRESS
    if (action === 'compress') {
      // IMAGE
      if (mime.startsWith('image/')) {
        const inputBuf = fs.readFileSync(filePath);
        const { buffer: compBuf, mime: compMime, ext } = await compressImageBuffer(inputBuf, mime, quality);
        outBuffer = compBuf;
        outMime = compMime;
        outFilename = safeName(originalName, '_compressed', ext);
      }

      // AUDIO / VIDEO
      else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        // Choose output ext (keep same)
        outExt = originalExt || (mime.startsWith('audio/') ? 'mp3' : 'mp4');
        outFilename = safeName(originalName, '_compressed', outExt);
        const outPath = path.join(path.dirname(filePath), `${path.basename(filePath)}_compressed.${outExt}`);

        // Choose conservative but effective bitrates depending on file size
        const stats = fs.statSync(filePath);
        const sizeMB = Math.max(stats.size / (1024 * 1024), 0.1);
        // lower bitrate for smaller target size
        const targetVideoBitrate = Math.max(400, Math.min(1500, Math.round(1200 / Math.log2(Math.max(sizeMB, 1) + 1))));
        const targetAudioBitrate = 96; // kbps

        await new Promise((resolve, reject) => {
          const cmd = ffmpeg(filePath)
            .outputOptions('-preset', 'veryfast')
            .videoBitrate(`${targetVideoBitrate}k`)
            .audioBitrate(`${targetAudioBitrate}k`)
            .on('end', resolve)
            .on('error', reject)
            .save(outPath);
        });

        outBuffer = fs.readFileSync(outPath);
        outMime = mime;
        cleanup(outPath);
      }

      // OTHER (docs) -> fallback: return original (no-op) but still safe
      else {
        outBuffer = fs.readFileSync(filePath);
        outMime = mime;
        outFilename = safeName(originalName, '_compressed', originalExt || 'bin');
      }
    }

    // ACTION: CONVERT
    else if (action === 'convert') {
      // IMAGES -> to target format (not avif)
      if (mime.startsWith('image/')) {
        const inputBuf = fs.readFileSync(filePath);
        // target formats allowed: jpeg,jpg,png,webp (avif removed)
        const fmt = (chosenFormat || originalExt).replace('jpg', 'jpeg');
        const allowed = ['jpeg', 'png', 'webp'];
        const outFmt = allowed.includes(fmt) ? fmt : 'jpeg';
        const converted = await sharp(inputBuf).toFormat(outFmt, { quality: Math.max(60, +quality || 75) }).toBuffer();
        outBuffer = converted;
        outMime = `image/${outFmt === 'jpeg' ? 'jpeg' : outFmt}`;
        outFilename = safeName(originalName, '_converted', outFmt === 'jpeg' ? 'jpg' : outFmt);
      }

      // PDF conversions
      else if (mime === 'application/pdf' || originalExt === 'pdf') {
        // PDF -> TXT (extract text)
        if (chosenFormat === 'txt') {
          const data = fs.readFileSync(filePath);
          const parsed = await PDFParser(data);
          const text = parsed && parsed.text ? parsed.text.trim() : '';
          outBuffer = Buffer.from(text || '', 'utf8');
          outMime = 'text/plain';
          outFilename = safeName(originalName, '_page1', 'txt');
        }
        // PDF -> DOCX (wrap text in simple docx)
        else if (chosenFormat === 'docx') {
          const data = fs.readFileSync(filePath);
          const parsed = await PDFParser(data);
          const text = (parsed && parsed.text) ? parsed.text.trim() : '';
          const doc = new Document();
          const paragraphs = (text.length ? text.split(/\n+/).slice(0, 1000) : ['']).map(p => new Paragraph({ children: [ new TextRun(p) ] }));
          doc.addSection({ properties: {}, children: paragraphs });
          const buffer = await Packer.toBuffer(doc);
          outBuffer = buffer;
          outMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          outFilename = safeName(originalName, '_converted', 'docx');
        }
        // PDF -> HTML (simple wrapper of text)
        else if (chosenFormat === 'html') {
          const data = fs.readFileSync(filePath);
          const parsed = await PDFParser(data);
          const text = (parsed && parsed.text) ? parsed.text.trim() : '';
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${originalName}</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
          outBuffer = Buffer.from(html, 'utf8');
          outMime = 'text/html';
          outFilename = safeName(originalName, '_converted', 'html');
        }
        // PDF -> image (png/jpg/webp) : attempt first-page thumbnail
        else if (['png', 'jpg', 'jpeg', 'webp'].includes(chosenFormat || '')) {
          const ext = (chosenFormat === 'jpg') ? 'jpeg' : (chosenFormat || 'png');
          const tmpOut = path.join(path.dirname(filePath), `${path.basename(filePath)}_page1.png`);
          const ok = await pdfFirstPageToImage(filePath, tmpOut);
          if (!ok || !fs.existsSync(tmpOut)) {
            // fallback: respond with an error telling server lacks pdf->image support
            throw new Error('PDF-to-image conversion failed: server missing pdf rendering dependencies (sharp/poppler).');
          }
          // re-encode to target format
          const imgBuf = fs.readFileSync(tmpOut);
          const converted = await sharp(imgBuf).toFormat(ext === 'jpeg' ? 'jpeg' : ext, { quality: Math.max(60, +quality || 75) }).toBuffer();
          outBuffer = converted;
          outMime = `image/${ext === 'jpeg' ? 'jpeg' : ext}`;
          outFilename = safeName(originalName, '_page1', ext === 'jpeg' ? 'jpg' : ext);
          cleanup(tmpOut);
        }
        // no target -> default: return original pdf
        else {
          outBuffer = fs.readFileSync(filePath);
          outMime = 'application/pdf';
          outFilename = safeName(originalName, '_converted', 'pdf');
        }
      }

      // TEXT / HTML -> pdf or text
      else if (mime.includes('text') || mime.includes('html') || mime.includes('json')) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (chosenFormat === 'pdf') {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on('data', d => chunks.push(d));
          doc.on('end', () => {});
          doc.fontSize(12).text(text);
          doc.end();
          // we must capture the stream synchronously, but easier is to write to buffer:
          // create temporary PDF file
          const tmp = path.join(path.dirname(filePath), `${path.basename(filePath)}.pdf`);
          // write using pdfkit to tmp
          await new Promise((resolve) => {
            const out = fs.createWriteStream(tmp);
            const docWrite = new PDFDocument();
            docWrite.pipe(out);
            docWrite.fontSize(12).text(text);
            docWrite.end();
            out.on('close', resolve);
          });
          outBuffer = fs.readFileSync(tmp);
          outMime = 'application/pdf';
          outFilename = safeName(originalName, '_converted', 'pdf');
          cleanup(tmp);
        } else {
          outBuffer = Buffer.from(text, 'utf8');
          outMime = 'text/plain';
          outFilename = safeName(originalName, '_converted', 'txt');
        }
      }

      // AUDIO / VIDEO conversion to target format
      else if ((mime.startsWith('audio/') || mime.startsWith('video/')) && chosenFormat) {
        const outExt = chosenFormat;
        outFilename = safeName(originalName, '_converted', outExt);
        const outPath = path.join(path.dirname(filePath), `${path.basename(filePath)}_converted.${outExt}`);
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputOptions('-preset', 'veryfast')
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        outBuffer = fs.readFileSync(outPath);
        outMime = mime.startsWith('audio/') ? `audio/${outExt}` : `video/${outExt}`;
        cleanup(outPath);
      }

      // fallback: return original
      else {
        outBuffer = fs.readFileSync(filePath);
        outMime = mime;
        outFilename = safeName(originalName, '_converted', originalExt || 'bin');
      }
    }

    // Final: send result, cleanup temp file AFTER send
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`);
    res.end(outBuffer, () => {
      cleanup(filePath);
    });

  } catch (e) {
    console.error('❌ Processing failed:', e && e.message ? e.message : e);
    // ensure request file cleanup if possible
    try { if (req.file && req.file.path) cleanup(req.file.path); } catch (_) {}
    // return JSON error (frontend expects blob; but non-200 is ok)
    res.status(500).json({ error: 'File processing failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

function escapeHtml(text) {
  return (text || '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
}

module.exports = router;
    
