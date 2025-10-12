
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const { PDFDocument } = require('pdf-lib');
const PDFKit = require('pdfkit');
const mime = require('mime-types');

module.exports = function(app) {
  const router = express.Router();
  const TMP = os.tmpdir();
  const upload = multer({ dest: path.join(TMP, 'uploads') });

  const safeDelete = f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} };

  // 🔹 Compress images (70% quality)
  async function compressImage(input, output) {
    const info = await sharp(input).metadata();
    const width = info.width > 1600 ? 1600 : info.width;
    await sharp(input)
      .resize({ width })
      .jpeg({ quality: 70 })
      .toFile(output);
    return output;
  }

  // 🔹 Convert image to PDF
  async function imageToPDF(image, output) {
    return new Promise((resolve, reject) => {
      const doc = new PDFKit({ autoFirstPage: false });
      const stream = fs.createWriteStream(output);
      doc.pipe(stream);
      sharp(image).metadata().then(meta => {
        doc.addPage({ size: [meta.width, meta.height] });
        doc.image(image, 0, 0, { width: meta.width, height: meta.height });
        doc.end();
        stream.on('finish', () => resolve(output));
        stream.on('error', reject);
      });
    });
  }

  // 🔹 Simplified PDF compression using pdf-lib
  async function compressPDF(input, output) {
    const pdfDoc = await PDFDocument.load(fs.readFileSync(input));
    const newPdf = await PDFDocument.create();
    const pages = await newPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
    pages.forEach(p => newPdf.addPage(p));
    const bytes = await newPdf.save({ useObjectStreams: true });
    fs.writeFileSync(output, bytes);
    return output;
  }

  // 🔹 Handle ZIP compression (for multiple files)
  async function zipFile(input, output) {
    const zip = new AdmZip();
    zip.addLocalFile(input);
    zip.writeZip(output);
    return output;
  }

  // 🔹 Universal File Processor
  router.post('/process', upload.single('file'), async (req, res) => {
    const { action = 'convert', targetFormat = '', quality = 70 } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const inputPath = file.path;
    const base = path.basename(file.originalname, path.extname(file.originalname));
    const ext = targetFormat.toLowerCase();
    const outputPath = path.join(TMP, `${base}_${Date.now()}.${ext || 'out'}`);

    try {
      const type = mime.lookup(file.originalname) || '';

      let finalFile = inputPath;

      // 🔸 Compress
      if (action === 'compress') {
        if (type.startsWith('image/')) finalFile = await compressImage(inputPath, outputPath);
        else if (type === 'application/pdf') finalFile = await compressPDF(inputPath, outputPath);
        else finalFile = await zipFile(inputPath, outputPath);
      }

      // 🔸 Convert
      else if (action === 'convert') {
        if (type.startsWith('image/') && ext === 'pdf') finalFile = await imageToPDF(inputPath, outputPath);
        else if (type.startsWith('image/') && ext) {
          await sharp(inputPath).toFormat(ext, { quality: Number(quality) }).toFile(outputPath);
          finalFile = outputPath;
        } else if (ext === 'zip') finalFile = await zipFile(inputPath, outputPath);
      }

      // Send file
      const stat = fs.statSync(finalFile);
      res.setHeader('Content-Type', mime.lookup(finalFile) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(finalFile)}"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);
      stream.on('close', () => { safeDelete(inputPath); safeDelete(finalFile); });

    } catch (err) {
      console.error('Error:', err);
      res.status(500).json({ error: 'Processing failed', details: err.message });
      safeDelete(inputPath); safeDelete(outputPath);
    }
  });

  app.use('/api/tools/file', router);
};
  
