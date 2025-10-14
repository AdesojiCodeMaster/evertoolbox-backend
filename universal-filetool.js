// universal-filetool.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Create output dir if missing
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');

// --- Helper to send error response ---
const sendError = (res, msg) => res.status(400).json({ success: false, message: msg });

// --- POST /process ---
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return sendError(res, 'No file uploaded');

    const action = req.body.action;
    const format = req.body.format?.toLowerCase() || '';
    const keepSameFormat = req.body.keepSameFormat === 'true';
    const inputPath = req.file.path;
    const inputExt = path.extname(req.file.originalname).replace('.', '');
    const inputName = path.parse(req.file.originalname).name;
    let outputPath = '';

    // ---------- IMAGE & DOC HANDLING ----------
    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
    const docExts = ['pdf', 'txt', 'docx', 'html'];
    const audioExts = ['mp3', 'wav', 'ogg'];
    const videoExts = ['mp4', 'mov', 'webm'];

    // --- Prevent redundant conversion ---
    if (action === 'convert' && format === inputExt)
      return sendError(res, `File is already in .${format} format.`);

    // --- Convert ---
    if (action === 'convert') {
      // IMAGE or DOC
      if (imageExts.includes(inputExt) || docExts.includes(inputExt)) {
        outputPath = `outputs/${inputName}.${format}`;
        exec(`magick "${inputPath}" "${outputPath}"`, (err) => {
          fs.unlinkSync(inputPath);
          if (err) return sendError(res, 'Conversion failed.');
          return res.json({
            success: true,
            downloadUrl: `/outputs/${path.basename(outputPath)}`,
            message: 'Conversion completed successfully.'
          });
        });
      }
      // AUDIO or VIDEO
      else if (audioExts.includes(inputExt) || videoExts.includes(inputExt)) {
        outputPath = `outputs/${inputName}.${format}`;
        ffmpeg(inputPath)
          .toFormat(format)
          .on('end', () => {
            fs.unlinkSync(inputPath);
            res.json({
              success: true,
              downloadUrl: `/outputs/${path.basename(outputPath)}`,
              message: 'Conversion completed successfully.'
            });
          })
          .on('error', (e) => {
            fs.unlinkSync(inputPath);
            sendError(res, 'Processing failed. Try again.');
          })
          .save(outputPath);
      }
      else return sendError(res, 'Unsupported file type for conversion.');
    }

    // --- Compress ---
    else if (action === 'compress') {
      outputPath = `outputs/${inputName}_compressed.${inputExt}`;
      if (imageExts.includes(inputExt)) {
        exec(`magick "${inputPath}" -quality 70 "${outputPath}"`, (err) => {
          fs.unlinkSync(inputPath);
          if (err) return sendError(res, 'Compression failed.');
          res.json({
            success: true,
            downloadUrl: `/outputs/${path.basename(outputPath)}`,
            message: 'Compression completed successfully.'
          });
        });
      } else if (audioExts.includes(inputExt)) {
        ffmpeg(inputPath)
          .audioBitrate('96k')
          .on('end', () => {
            fs.unlinkSync(inputPath);
            res.json({
              success: true,
              downloadUrl: `/outputs/${path.basename(outputPath)}`,
              message: 'Audio compressed successfully.'
            });
          })
          .on('error', (err) => sendError(res, 'Audio compression failed.'))
          .save(outputPath);
      } else if (videoExts.includes(inputExt)) {
        ffmpeg(inputPath)
          .videoBitrate('800k')
          .outputOptions(['-preset fast'])
          .on('end', () => {
            fs.unlinkSync(inputPath);
            res.json({
              success: true,
              downloadUrl: `/outputs/${path.basename(outputPath)}`,
              message: 'Video compressed successfully.'
            });
          })
          .on('error', (err) => sendError(res, 'Video compression failed.'))
          .save(outputPath);
      } else {
        fs.unlinkSync(inputPath);
        return sendError(res, 'Unsupported file type for compression.');
      }
    } else {
      return sendError(res, 'Invalid action.');
    }

  } catch (err) {
    console.error(err);
    return sendError(res, 'Unexpected error occurred.');
  }
});

// Serve files from /outputs
router.use('/outputs', express.static(path.join(__dirname, 'outputs')));

module.exports = router;
            
