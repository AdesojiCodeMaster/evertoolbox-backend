// universal-filetool.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const mime = require('mime-types');
const AdmZip = require('adm-zip');

const router = express.Router();
const upload = multer({ dest: os.tmpdir() });

function safeUnlink(p){ try{ if(p && fs.existsSync(p)) fs.unlinkSync(p); }catch(e){} }
function mkTemp(name){ return path.join(os.tmpdir(), `${Date.now()}_${Math.round(Math.random()*99999)}_${name}`); }
function getExtFromMime(mimeType){
  const ext = mime.extension(mimeType || '') || '';
  return ext;
}

// Create compressed candidates for images and pick the smallest (< original)
async function compressImageCandidates(inputPath, options = {}) {
  const origStat = fs.statSync(inputPath);
  const origSize = origStat.size;
  const outBase = mkTemp(path.basename(inputPath).replace(/\.[^/.]+$/, '') + '_cmp');

  const meta = await sharp(inputPath).metadata().catch(()=>({width:null,height:null}));
  const maxDim = options.maxDim || 1200;
  const width = (meta.width && Math.max(meta.width, meta.height) > maxDim) ? Math.round(Math.max(meta.width, meta.height) > 0 ? (maxDim * meta.width / Math.max(meta.width, meta.height)) : maxDim) : meta.width;

  const candidates = [];

  // 1) WebP aggressive
  try {
    const out1 = outBase + '.webp';
    await sharp(inputPath)
      .resize({ width: width || undefined })
      .webp({ quality: Math.max(10, Math.min(60, Math.round((options.quality || 80) * 0.4))) })
      .toFile(out1);
    candidates.push(out1);
  } catch(e){}

  // 2) JPEG (if image not PNG palette)
  try {
    const out2 = outBase + '.jpg';
    await sharp(inputPath)
      .resize({ width: width || undefined })
      .jpeg({ quality: Math.max(12, Math.min(70, Math.round((options.quality || 80) * 0.6))) })
      .toFile(out2);
    candidates.push(out2);
  } catch(e){}

  // 3) PNG optimized (use PNG compressionLevel)
  try {
    const out3 = outBase + '.png';
    await sharp(inputPath)
      .resize({ width: width || undefined })
      .png({ compressionLevel: 9 })
      .toFile(out3);
    candidates.push(out3);
  } catch(e){}

  // from candidates pick the smallest file that is smaller than orig; if none, pick smallest but only if <= orig, else return original
  let best = null;
  for(const c of candidates){
    try {
      const s = fs.statSync(c).size;
      if(s < origSize && (!best || s < fs.statSync(best).size)) best = c;
    } catch(e){}
  }
  if(!best){
    // allow equal or slightly larger? No — return original if none smaller
    // cleanup temp candidates
    candidates.forEach(c=>safeUnlink(c));
    return { path: inputPath, name: path.basename(inputPath) };
  }
  // remove other candidates
  candidates.forEach(c => { if(c !== best) safeUnlink(c); });
  return { path: best, name: path.basename(best) };
}

// convert image to PDF using pdf-lib (robust)
async function imageToPdf(imagePath, outPdfPath){
  const bytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  let img;
  const mimeType = mime.lookup(imagePath) || '';
  if(mimeType === 'image/png') img = await pdfDoc.embedPng(bytes);
  else img = await pdfDoc.embedJpg(bytes).catch(async () => {
    // if not jpg, convert to png via sharp then embed
    const tmp = mkTemp('tmp_conv.png');
    await sharp(imagePath).png().toFile(tmp);
    const b = fs.readFileSync(tmp);
    const embedded = await pdfDoc.embedPng(b);
    safeUnlink(tmp);
    return embedded;
  });
  const page = pdfDoc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outPdfPath, pdfBytes);
  return outPdfPath;
}

router.get('/api/tools/file/health', (req, res) => res.json({ status: 'ok' }));

router.post('/api/tools/file/process', upload.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const action = (req.body.action || 'convert').toLowerCase();
  const targetFormat = (req.body.targetFormat || '').toLowerCase();
  const quality = Math.max(8, Math.min(95, parseInt(req.body.quality || '80', 10)));
  const uploaded = req.file;
  const inputPath = uploaded.path;
  const originalName = uploaded.originalname || 'file';
  const inputExt = path.extname(originalName).replace('.','').toLowerCase();
  const inputMime = uploaded.mimetype || mime.lookup(originalName) || '';
  const basename = path.basename(originalName, path.extname(originalName));

  // output defaults to original ext unless convert target provided
  let desiredExt = targetFormat || inputExt;
  let outPath = mkTemp(`${basename}_out.${desiredExt}`);

  try {
    // IMAGE-specific
    if(action === 'compress' && inputMime.startsWith('image/')) {
      const result = await compressImageCandidates(inputPath, { quality });
      // result.path may be original path (no compression) or compressed file
      let finalPath = result.path;
      let finalName = result.name;
      // if compressed format changed extension and user asked to keep same ext, optionally convert back? We will return compressed file with its extension to avoid size blow-ups.
      const stat = fs.statSync(finalPath);
      res.setHeader('Content-Type', mime.lookup(finalPath) || 'application/octet-stream');
      // ensure filename has correct extension
      const outFilename = path.basename(finalPath);
      res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(finalPath);
      stream.on('close', () => {
        // cleanup: unlink input if different from finalPath
        if(finalPath !== inputPath) safeUnlink(inputPath);
        // do not unlink finalPath immediately — let OS clean temp later; but safeUnlink on next operations
      });
      return stream.pipe(res);
    }

    // IMAGE convert (including image -> pdf)
    if(action === 'convert' && inputMime.startsWith('image/')) {
      if(desiredExt === 'pdf') {
        // generate valid PDF with embedded image
        outPath = mkTemp(`${basename}_conv.pdf`);
        await imageToPdf(inputPath, outPath);
      } else {
        // convert image to desired ext using sharp and requested quality
        outPath = mkTemp(`${basename}_conv.${desiredExt}`);
        await sharp(inputPath).toFormat(desiredExt, { quality }).toFile(outPath);
      }
      const stat = fs.statSync(outPath);
      res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
      res.setHeader('Content-Length', stat.size);
      const s = fs.createReadStream(outPath);
      s.on('close', ()=>{ safeUnlink(inputPath); /* optional: safeUnlink(outPath) later */ });
      return s.pipe(res);
    }

    // PDF compression or preview handling
    if((action === 'compress' && (inputMime === 'application/pdf' || inputExt === 'pdf')) || (action === 'convert' && desiredExt === 'pdf' && inputMime === 'application/pdf')) {
      // For PDF we do a JS re-encode using pdf-lib (preserves content and reduces some overhead)
      outPath = mkTemp(`${basename}_pdf.${desiredExt || 'pdf'}`);
      try {
        // try to compress by loading and saving
        const pdfBytes = fs.readFileSync(inputPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const copied = await PDFDocument.create();
        const pages = await copied.copyPages(pdfDoc, pdfDoc.getPageIndices());
        pages.forEach(p => copied.addPage(p));
        const outBytes = await copied.save({ useObjectStreams: true });
        fs.writeFileSync(outPath, outBytes);
      } catch(e) {
        // fallback: send original
        fs.copyFileSync(inputPath, outPath);
      }
      const stat = fs.statSync(outPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${basename}.pdf"`);
      res.setHeader('Content-Length', stat.size);
      const s2 = fs.createReadStream(outPath);
      s2.on('close', ()=>{ safeUnlink(inputPath); });
      return s2.pipe(res);
    }

    // AUDIO / VIDEO / OTHER — fallback: echo original (safe)
    // If you later enable ffmpeg, replace this block with transcoding.
    // For now, return original file (no .bin) and correct headers.
    const finalPath = inputPath;
    const stat = fs.statSync(finalPath);
    const extOut = path.extname(originalName) || '';
    const outName = `${basename}${extOut}`;
    res.setHeader('Content-Type', inputMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.setHeader('Content-Length', stat.size);
    const s3 = fs.createReadStream(finalPath);
    s3.on('close', ()=>{ /* keep input for now; will be removed on next job or OS temp cleaners */ });
    return s3.pipe(res);

  } catch (err) {
    console.error('filetool error', err);
    safeUnlink(inputPath);
    return res.status(500).json({ error: 'Processing failed', details: String(err.message || err) });
  }
});

module.exports = router;
  
