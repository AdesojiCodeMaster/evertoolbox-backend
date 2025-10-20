// universal-filetool.js (CommonJS, Express Router)
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { exec } = require('child_process');

const router = express.Router();

// Create upload directory if it doesn’t exist
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

// ------------------------------
// Handle compression & conversion
// POST /api/tools/file
// ------------------------------
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { mode, format } = req.body;
    const filePath = req.file?.path;
    if (!filePath) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // ---------- File Compression ----------
    if (mode === 'compress') {
      const compressedPath = `${filePath}.zip`;
      const cmd = `zip -j -9 "${compressedPath}" "${filePath}"`;
      exec(cmd, (err) => {
        if (err) {
          console.error('Compression error:', err);
          return res.status(500).json({ error: 'Compression failed' });
        }
        res.download(compressedPath, path.basename(compressedPath), (errDown) => {
          cleanupFiles([filePath, compressedPath]);
        });
      });
      return;
    }

    // ---------- Image Conversion ----------
    if (mode === 'convert' && format) {
      const targetFormat = format.toLowerCase();
      const outputPath = `${filePath}.${targetFormat}`;
      const img = sharp(filePath);

      await img.toFormat(targetFormat).toFile(outputPath);

      res.download(outputPath, `converted.${targetFormat}`, (errDown) => {
        cleanupFiles([filePath, outputPath]);
      });
      return;
    }

    // ---------- Document Conversion (PDF <-> DOCX etc.) ----------
    if (mode === 'convert-doc' && format) {
      const target = format.replace(/^\./, '');
      const outDir = path.dirname(filePath);
      const cmd = `soffice --headless --convert-to ${target} --outdir ${outDir} ${filePath}`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error('LibreOffice conversion error:', stderr);
          cleanupFiles([filePath]);
          return res.status(500).json({ error: 'Document conversion failed. Ensure LibreOffice is installed.' });
        }
        const outputFile = filePath.replace(/\.[^/.]+$/, `.${target}`);
        res.download(outputFile, path.basename(outputFile), () => {
          cleanupFiles([filePath, outputFile]);
        });
      });
      return;
    }

    // ---------- Invalid mode ----------
    return res.status(400).json({ error: 'Invalid mode or missing format.' });
  } catch (err) {
    console.error('File tool error:', err);
    res.status(500).json({ error: 'File processing failed' });
  }
});

// ------------------------------
// Helper: Cleanup files
// ------------------------------
function cleanupFiles(files) {
  files.forEach(f => {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  });
}

module.exports = router;
        
