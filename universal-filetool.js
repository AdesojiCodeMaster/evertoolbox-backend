// universal-filetool.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const PDFDocument = require('pdfkit');

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

const supportedFormats = {
  images: ['jpg', 'png', 'webp', 'gif'],
  audio: ['mp3', 'wav', 'ogg'],
  video: ['mp4', 'avi', 'mov', 'webm'],
  documents: ['pdf', 'docx', 'txt', 'md']
};

// Utility to check if format is supported
function isSupported(format) {
  return Object.values(supportedFormats).flat().includes(format);
}

// Convert image
async function convertImage(inputPath, outputPath, targetFormat) {
  await sharp(inputPath)
    .toFormat(targetFormat)
    .toFile(outputPath);
}

// Convert audio/video
function convertMedia(inputPath, outputPath, targetFormat) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

// Generate PDF thumbnail
async function generatePdfThumbnail(pdfPath, thumbPath) {
  // For simplicity, generate a blank thumbnail
  const doc = new PDFDocument({ size: [200, 200] });
  const stream = fs.createWriteStream(thumbPath);
  doc.pipe(stream);
  doc.fontSize(25).text('PDF Preview', 50, 80);
  doc.end();
  await new Promise((res) => stream.on('finish', res));
}

// Compress images
async function compressImage(inputPath, outputPath) {
  await sharp(inputPath)
    .jpeg({ quality: 70 }) // Adjust quality for compression
    .toFile(outputPath);
}

// Compress audio/video
function compressMedia(inputPath, outputPath) {
  // Placeholder: using ffmpeg to reduce bitrate for compression
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoBitrate('500k')
      .audioBitrate('128k')
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Endpoint handler
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { targetFormat, operation } = req.body; // operation: 'convert' or 'compress'
    const file = req.file;

    if (!file || !targetFormat || !operation) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const inputPath = file.path;
    const ext = path.extname(file.originalname).slice(1).toLowerCase();

    if (!isSupported(ext) || !isSupported(targetFormat)) {
      fs.unlinkSync(inputPath);
      return res.status(400).json({ error: 'Unsupported format' });
    }

    const outputFilename = `${path.parse(file.originalname).name}_${Date.now()}.${targetFormat}`;
    const outputPath = path.join('outputs', outputFilename);

    // Ensure output directory exists
    fs.mkdirSync('outputs', { recursive: true });

    if (['jpg', 'png', 'webp', 'gif'].includes(ext)) {
      if (operation === 'convert') {
        await convertImage(inputPath, outputPath, targetFormat);
      } else if (operation === 'compress') {
        await compressImage(inputPath, outputPath);
      }
    } else if (['mp3', 'wav', 'ogg', 'mp4', 'avi', 'mov', 'webm'].includes(ext)) {
      if (operation === 'convert') {
        await convertMedia(inputPath, outputPath, targetFormat);
      } else if (operation === 'compress') {
        await compressMedia(inputPath, outputPath);
      }
    } else if (['pdf', 'docx', 'txt', 'md'].includes(ext)) {
      if (operation === 'convert') {
        // For simplicity, only convert to PDF (if not already) or generate a thumbnail
        if (ext !== 'pdf' && targetFormat === 'pdf') {
          // Convert docx/txt/md to PDF
          const doc = new PDFDocument();
          const stream = fs.createWriteStream(outputPath);
          doc.pipe(stream);
          const content = fs.readFileSync(inputPath, 'utf8');
          doc.text(content);
          doc.end();
          await new Promise((res) => stream.on('finish', res));
        } else {
          // Unsupported conversion
          fs.unlinkSync(inputPath);
          return res.status(400).json({ error: 'Unsupported document conversion' });
        }
      } else if (operation === 'compress') {
        // For documents, compression may not be applicable
        fs.copyFileSync(inputPath, outputPath);
      }
    } else {
      fs.unlinkSync(inputPath);
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Generate thumbnail for PDFs
    if (ext === 'pdf') {
      const thumbPath = outputPath.replace(`.${targetFormat}`, '_thumb.png');
      await generatePdfThumbnail(outputPath, thumbPath);
    }

    // Clean up uploaded temp file
    fs.unlinkSync(inputPath);

    res.json({ outputUrl: `/downloads/${path.basename(outputPath)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Processing error' });
  }
});

module.exports = router;

// Note: Remember to import and use this router in your main server.js file with:
// const fileToolRouter = require('./universal-filetool');
// app.use('/api/tools/file', fileToolRouter);
