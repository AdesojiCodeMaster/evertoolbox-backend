// universal-filetool.js
// Drop this file into your project and require('./universal-filetool')(app);

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const mime = require('mime-types');
const AdmZip = require('adm-zip');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// configure ffmpeg path (ffmpeg-static provides binaries)
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

module.exports = function(app, opts = {}) {
  const router = express.Router();
  const TMP = opts.tmpDir || os.tmpdir();
  const upload = multer({ dest: path.join(TMP, 'uploads') });

  function safeUnlink(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {}
  }
  function mkTemp(name) {
    return path.join(TMP, `${Date.now()}_${Math.floor(Math.random()*90000)+10000}_${name}`);
  }
  function extFromMime(m) { return mime.extension(m || '') || ''; }

  // Generate compressed candidates for an image and return the best (smallest) file
  async function compressImageCandidates(inputPath, quality = 70, maxDim = 1600) {
    const stat = fs.statSync(inputPath);
    const origSize = stat.size;
    const meta = await sharp(inputPath).metadata().catch(()=>({ width: null, height: null }));
    const maxSide = Math.max(meta.width || 0, meta.height || 0);
    const scale = (maxSide > maxDim && maxSide>0) ? (maxDim / maxSide) : 1;
    const width = meta.width ? Math.round(meta.width * scale) : undefined;

    const base = path.basename(inputPath).replace(/\.[^/.]+$/, '');
    const outBase = mkTemp(base + '_cmp');

    const candidates = [];

    // Candidate 1: aggressive WebP
    try {
      const out1 = outBase + '.webp';
      await sharp(inputPath).resize({ width }).webp({ quality: Math.max(8, Math.min(70, Math.round(quality * 0.45))) }).toFile(out1);
      candidates.push(out1);
    } catch(e){}

    // Candidate 2: JPEG
    try {
      const out2 = outBase + '.jpg';
      await sharp(inputPath).resize({ width }).jpeg({ quality: Math.max(10, Math.min(80, Math.round(quality * 0.6))) }).toFile(out2);
      candidates.push(out2);
    } catch(e){}

    // Candidate 3: PNG optimized
    try {
      const out3 = outBase + '.png';
      await sharp(inputPath).resize({ width }).png({ compressionLevel: 9 }).toFile(out3);
      candidates.push(out3);
    } catch(e){}

    // Choose the smallest candidate that is strictly smaller than original.
    let best = null;
    for (const c of candidates) {
      try {
        const s = fs.statSync(c).size;
        if (s < origSize && (!best || s < fs.statSync(best).size)) best = c;
      } catch(e){}
    }

    // Cleanup non-best candidates
    candidates.forEach(c => { if (c !== best) safeUnlink(c); });

    if (best) return { path: best, name: path.basename(best), size: fs.statSync(best).size };

    // If no candidate is smaller, delete candidates and return original
    candidates.forEach(c => safeUnlink(c));
    return { path: inputPath, name: path.basename(inputPath), size: origSize };
  }

  // Convert (single-image) to PDF via pdf-lib
  async function imageToPdf(imagePath, outPdfPath) {
    const imgBytes = fs.readFileSync(imagePath);
    const pdfDoc = await PDFDocument.create();
    let embedded;
    // try embed jpg first, otherwise embed png (convert if necessary)
    try {
      embedded = await pdfDoc.embedJpg(imgBytes);
    } catch(e) {
      // convert to png and embed
      const tmp = mkTemp('tmp_conv.png');
      await sharp(imagePath).png().toFile(tmp);
      const b = fs.readFileSync(tmp);
      embedded = await pdfDoc.embedPng(b);
      safeUnlink(tmp);
    }
    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outPdfPath, pdfBytes);
    return outPdfPath;
  }

  // Re-encode / lighten PDF using pdf-lib by copying pages (JS-only, safe)
  async function reencodePdf(inputPath, outPath) {
    try {
      const bytes = fs.readFileSync(inputPath);
      const src = await PDFDocument.load(bytes);
      const dst = await PDFDocument.create();
      const pages = await dst.copyPages(src, src.getPageIndices());
      pages.forEach(p => dst.addPage(p));
      const outBytes = await dst.save({ useObjectStreams: true });
      fs.writeFileSync(outPath, outBytes);
      return outPath;
    } catch(e) {
      // fallback: copy original
      fs.copyFileSync(inputPath, outPath);
      return outPath;
    }
  }

  // transcode media via ffmpeg if available
  function transcodeMediaFfmpeg(inputPath, outPath, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!ffmpeg) return reject(new Error('ffmpeg not available'));
      const proc = ffmpeg(inputPath).outputOptions(opts.outputOptions || []);
      if (opts.format) proc.toFormat(opts.format);
      proc.on('end', () => resolve(outPath)).on('error', err => reject(err)).save(outPath);
    });
  }

  // Health
  router.get('/api/tools/file/health', (req, res) => res.json({ status: 'ok' }));

  // Core route
  router.post('/api/tools/file/process', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const action = (req.body.action || 'convert').toLowerCase();
    const targetFormat = (req.body.targetFormat || '').toLowerCase();
    const quality = Math.max(8, Math.min(95, parseInt(req.body.quality || '80', 10)));
    const fileObj = req.file;
    const inputPath = fileObj.path;
    const originalName = fileObj.originalname || 'file';
    const inputExt = path.extname(originalName).replace('.', '').toLowerCase();
    const inputMime = fileObj.mimetype || mime.lookup(originalName) || '';
    const baseName = path.basename(originalName, path.extname(originalName));

    // default output ext: targetFormat if provided otherwise inputExt
    const outExt = targetFormat || inputExt;

    try {
      // 1) IMAGE compression
      if (action === 'compress' && inputMime.startsWith('image/')) {
        const result = await compressImageCandidates(inputPath, quality);
        const finalPath = result.path;
        const finalName = result.name;
        const stat = fs.statSync(finalPath);
        res.setHeader('Content-Type', mime.lookup(finalPath) || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
        res.setHeader('Content-Length', stat.size);
        const r = fs.createReadStream(finalPath);
        r.on('close', () => {
          if (finalPath !== inputPath) safeUnlink(inputPath);
          // keep finalPath for a little while; OS will clean temp files, but we could remove it too
        });
        return r.pipe(res);
      }

      // 2) IMAGE conversion
      if (inputMime.startsWith('image/') && (action === 'convert')) {
        if (outExt === 'pdf') {
          const outPdf = mkTemp(`${baseName}_conv.pdf`);
          await imageToPdf(inputPath, outPdf);
          const stat = fs.statSync(outPdf);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
          res.setHeader('Content-Length', stat.size);
          const s = fs.createReadStream(outPdf);
          s.on('close', () => safeUnlink(inputPath));
          return s.pipe(res);
        } else {
          // convert to requested image format
          const outImage = mkTemp(`${baseName}_conv.${outExt}`);
          await sharp(inputPath).toFormat(outExt, { quality }).toFile(outImage);
          const stat = fs.statSync(outImage);
          res.setHeader('Content-Type', mime.lookup(outImage) || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outImage)}"`);
          res.setHeader('Content-Length', stat.size);
          const s = fs.createReadStream(outImage);
          s.on('close', () => safeUnlink(inputPath));
          return s.pipe(res);
        }
      }

      // 3) PDF handling (compress or convert)
      if (inputMime === 'application/pdf' || inputExt === 'pdf') {
        // If compress requested or convert requested to pdf - reencode
        if (action === 'compress' || (action === 'convert' && outExt === 'pdf')) {
          const outPdf = mkTemp(`${baseName}_pdf.pdf`);
          await reencodePdf(inputPath, outPdf);
          const stat = fs.statSync(outPdf);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
          res.setHeader('Content-Length', stat.size);
          const s = fs.createReadStream(outPdf);
          s.on('close', () => safeUnlink(inputPath));
          return s.pipe(res);
        }
      }

      // 4) AUDIO / VIDEO: try ffmpeg if available
      if ((inputMime.startsWith('audio/') || inputMime.startsWith('video/')) && (action === 'compress' || action === 'convert')) {
        // We will transcode using ffmpeg-static if available
        try {
          const outName = `${baseName}_conv.${outExt || (inputMime.startsWith('video/') ? 'mp4' : 'mp3')}`;
          const outPath = mkTemp(outName);
          const opts = {};
          // sample options for smaller size
          if (inputMime.startsWith('video/')) opts.outputOptions = ['-vcodec libx264', '-crf 28', '-preset veryfast', '-b:a 96k'];
          else opts.outputOptions = ['-b:a 96k'];
          if (outExt) opts.format = outExt;
          await transcodeMediaFfmpeg(inputPath, outPath, opts);
          const stat = fs.statSync(outPath);
          res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
          res.setHeader('Content-Length', stat.size);
          const s = fs.createReadStream(outPath);
          s.on('close', () => safeUnlink(inputPath));
          return s.pipe(res);
        } catch(e) {
          // if ffmpeg not available or failed, fallback to send original file
        }
      }

      // 5) TEXT / DOCX / OTHER: basic handling
      const lower = inputExt.toLowerCase();
      if (action === 'convert' && lower === 'txt' && outExt === 'pdf') {
        // Convert text -> PDF (simple)
        const text = fs.readFileSync(inputPath, 'utf8');
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        page.drawText(text.substring(0, 60000), { x: 20, y: height - 40, size: 10 });
        const outPdf = mkTemp(`${baseName}_conv.pdf`);
        fs.writeFileSync(outPdf, await pdfDoc.save());
        const stat = fs.statSync(outPdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        res.setHeader('Content-Length', stat.size);
        const s = fs.createReadStream(outPdf);
        s.on('close', () => safeUnlink(inputPath));
        return s.pipe(res);
      }

      // 6) Fallback: return a ZIP of the original if nothing done (avoids .bin)
      const zipOut = mkTemp(`${baseName}_result.zip`);
      const zip = new AdmZip();
      zip.addLocalFile(inputPath, '', originalName);
      zip.writeZip(zipOut);
      const stat = fs.statSync(zipOut);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}_result.zip"`);
      res.setHeader('Content-Length', stat.size);
      const s = fs.createReadStream(zipOut);
      s.on('close', () => safeUnlink(inputPath));
      return s.pipe(res);

    } catch (err) {
      console.error('universal-filetool processing error:', err);
      safeUnlink(inputPath);
      return res.status(500).json({ error: 'Processing failed', details: String(err && err.message ? err.message : err) });
    }
  });

  // mount router (keeps existing server.js untouched)
  app.use('/', router);
  return router;
};
