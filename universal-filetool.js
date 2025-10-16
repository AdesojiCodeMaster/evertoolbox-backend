// universal-filetool.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');

const router = express.Router();

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('jobs')) fs.mkdirSync('jobs'); // job status + outputs

const upload = multer({ dest: 'uploads/' });

function cleanup(file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
}

function writeStatus(id, data) {
  const statusFile = path.join('jobs', `${id}.json`);
  fs.writeFileSync(statusFile, JSON.stringify(data));
}
function readStatus(id) {
  const statusFile = path.join('jobs', `${id}.json`);
  if (!fs.existsSync(statusFile)) return null;
  try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (e) { return null; }
}

// map of safe output extensions to mimes (partial)
const mimeMap = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

router.get('/health', (req, res) => res.json({ ok: true }));

// POST /process -> returns { id } immediately and processes file asynchronously
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const input = req.file;
    if (!input) return res.status(400).json({ error: 'No file uploaded.' });

    const { action, targetFormat: rawTargetFormat, quality = 80 } = req.body;
    const targetFormat = (rawTargetFormat || '').toLowerCase();

    // AVIF is explicitly removed
    if (targetFormat === 'avif') {
      cleanup(input.path);
      return res.status(400).json({ error: 'AVIF format is not supported.' });
    }

    if (!action) {
      cleanup(input.path);
      return res.status(400).json({ error: 'Please select an action (convert or compress).' });
    }

    const id = uuidv4();
    const status = {
      id,
      startedAt: new Date().toISOString(),
      status: 'queued',
      progress: 0,
      message: 'Queued',
      inputName: input.originalname,
      outputName: null,
      outputMime: null
    };
    writeStatus(id, status);

    // Move job to async worker to avoid blocking the response
    (async () => {
      const jobStatusPath = path.join('jobs', `${id}.json`);
      try {
        status.status = 'processing';
        status.progress = 5;
        status.message = 'Processing started';
        writeStatus(id, status);

        const filePath = input.path;
        const mime = input.mimetype;
        const originalExt = path.extname(input.originalname).slice(1).toLowerCase();

        // default extension when preserving
        let outExt = targetFormat || originalExt;
        if (!outExt) outExt = originalExt || 'processed';

        // helper to finalize
        const finalize = (outPath, outMime) => {
          status.status = 'done';
          status.progress = 100;
          status.message = 'Completed';
          status.outputPath = outPath;
          status.outputMime = outMime || mimeMap[outExt] || 'application/octet-stream';
          status.outputName = path.basename(outPath);
          writeStatus(id, status);
          // clean input file
          cleanup(filePath);
        };

        // helper to write intermediate progress
        const setProgress = (p, msg) => {
          status.progress = Math.min(99, Math.max(status.progress, p));
          if (msg) status.message = msg;
          writeStatus(id, status);
        };

        // Ensure compression re-encodes small files: we always re-encode for images
        if (action === 'compress' && mime.startsWith('image/')) {
          setProgress(10, 'Compressing image');
          // Re-encode to jpeg/png/webp depending on original
          // force jpeg for better compression unless original is png and transparency exists
          const inputBuffer = fs.readFileSync(filePath);
          const image = sharp(inputBuffer);
          const meta = await image.metadata();

          // If image has alpha, prefer png/webp; otherwise jpeg with specified quality
          if (meta.hasAlpha) {
            // re-encode to webp with quality but keep lossless off
            const outBuffer = await image.webp({ quality: Math.max(40, Math.min(quality, 85)) }).toBuffer();
            const outPath = path.join('jobs', `${id}_result.webp`);
            fs.writeFileSync(outPath, outBuffer);
            finalize(outPath, 'image/webp');
            return;
          } else {
            const outBuffer = await image.jpeg({ quality: Math.max(40, Math.min(quality, 85)), mozjpeg: true }).toBuffer();
            const outPath = path.join('jobs', `${id}_result.jpg`);
            fs.writeFileSync(outPath, outBuffer);
            finalize(outPath, 'image/jpeg');
            return;
          }
        }

        // Audio / video compression
        if (action === 'compress' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
          setProgress(10, 'Compressing media');
          // choose extension
          const isAudio = mime.startsWith('audio/');
          const outExtChoose = isAudio ? 'mp3' : 'mp4';
          const outPath = path.join('jobs', `${id}_result.${outExtChoose}`);

          await new Promise((resolve, reject) => {
            const proc = ffmpeg(filePath)
              // compression-focused presets
              .outputOptions([
                '-preset ultrafast',
                '-movflags +faststart'
              ])
              // modest video bitrate; audio default 128k
              .audioBitrate('128k')
              .videoBitrate('800k')
              .on('start', () => { setProgress(15, 'ffmpeg started'); })
              .on('progress', progress => {
                // map ffmpeg percent to our progress
                const p = Math.min(90, 15 + Math.round((progress.percent || 0) * 0.7));
                setProgress(p, `Encoding: ${Math.round(progress.percent || 0)}%`);
              })
              .on('end', () => resolve())
              .on('error', (err) => reject(err))
              .save(outPath);
          });

          finalize(outPath, isAudio ? 'audio/mpeg' : 'video/mp4');
          return;
        }

        // Conversion
        if (action === 'convert') {
          // reject no target
          if (!targetFormat) {
            status.status = 'failed';
            status.progress = 0;
            status.message = 'Missing targetFormat for conversion';
            writeStatus(id, status);
            cleanup(filePath);
            return;
          }

          // image conversion (including from PDF first-page to image)
          if (mime.startsWith('image/') || path.extname(input.originalname).toLowerCase() === '.pdf') {
            setProgress(15, 'Converting image/PDF');

            // If PDF -> image: try to load first page using sharp (requires libvips with pdf support)
            if ((path.extname(input.originalname).toLowerCase() === '.pdf') && ['png','jpg','jpeg','webp'].includes(targetFormat)) {
              const tryPath = filePath + '[0]'; // sharp syntax for first page
              try {
                const outBuf = await sharp(tryPath).toFormat(targetFormat === 'jpg' ? 'jpeg' : targetFormat, { quality: Math.max(50, Math.min(quality, 90)) }).toBuffer();
                const outPath = path.join('jobs', `${id}_result.${targetFormat === 'jpg' ? 'jpg' : targetFormat}`);
                fs.writeFileSync(outPath, outBuf);
                finalize(outPath, mimeMap[targetFormat] || `image/${targetFormat}`);
                return;
              } catch (e) {
                // fallback: respond with failure for that conversion path
                status.status = 'failed';
                status.message = 'PDF to image conversion failed: environment may lack pdf support in sharp.';
                writeStatus(id, status);
                cleanup(filePath);
                return;
              }
            }

            // generic image conversion path
            if (mime.startsWith('image/')) {
              const image = sharp(filePath);
              const fmt = (targetFormat === 'jpg') ? 'jpeg' : targetFormat;
              const outBuf = await image.toFormat(fmt, { quality: Math.max(50, Math.min(quality, 90)) }).toBuffer();
              const outPath = path.join('jobs', `${id}_result.${fmt === 'jpeg' ? 'jpg' : fmt}`);
              fs.writeFileSync(outPath, outBuf);
              finalize(outPath, mimeMap[fmt] || `image/${fmt}`);
              return;
            }
          }

          // Document/text conversion
          if (mime === 'application/pdf' || path.extname(input.originalname).toLowerCase() === '.pdf') {
            setProgress(20, 'Processing PDF');
            const dataBuffer = fs.readFileSync(filePath);

            // PDF -> TXT
            if (targetFormat === 'txt') {
              try {
                const data = await pdfParse(dataBuffer);
                const outPath = path.join('jobs', `${id}_result.txt`);
                fs.writeFileSync(outPath, data.text || '');
                finalize(outPath, 'text/plain');
                return;
              } catch (e) {
                status.status = 'failed';
                status.message = 'PDF text extraction failed';
                writeStatus(id, status);
                cleanup(filePath);
                return;
              }
            }

            // PDF -> PDF (no-op)
            if (targetFormat === 'pdf') {
              // just pass through
              const outPath = path.join('jobs', `${id}_result.pdf`);
              fs.copyFileSync(filePath, outPath);
              finalize(outPath, 'application/pdf');
              return;
            }

            // For PDF -> html/docx, do a simple TXT->wrap fallback (docx generation would normally require a library)
            if (['html','docx'].includes(targetFormat)) {
              try {
                const data = await pdfParse(dataBuffer);
                if (targetFormat === 'html') {
                  const outPath = path.join('jobs', `${id}_result.html`);
                  const html = `<html><body><pre>${escapeHtml(data.text || '')}</pre></body></html>`;
                  fs.writeFileSync(outPath, html, 'utf8');
                  finalize(outPath, 'text/html');
                  return;
                } else { // docx fallback: create a simple .docx-like file by using .docx extension and plain text inside
                  const outPath = path.join('jobs', `${id}_result.docx`);
                  fs.writeFileSync(outPath, data.text || '', 'utf8');
                  finalize(outPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                  return;
                }
              } catch (e) {
                status.status = 'failed';
                status.message = 'PDF conversion failed';
                writeStatus(id, status);
                cleanup(filePath);
                return;
              }
            }
          }

          // Plain text/JSON/HTML conversions
          if (mime.includes('text') || mime.includes('json') || mime.includes('html')) {
            const text = fs.readFileSync(filePath, 'utf8');
            if (targetFormat === 'pdf') {
              // create a PDF with the text content
              const doc = new PDFDocument();
              const outPath = path.join('jobs', `${id}_result.pdf`);
              const writeStream = fs.createWriteStream(outPath);
              doc.pipe(writeStream);
              doc.fontSize(12).text(text);
              doc.end();
              await new Promise((resolve) => writeStream.on('finish', resolve));
              finalize(outPath, 'application/pdf');
              return;
            } else {
              // other text formats -> plain text file with proper extension
              const ext = targetFormat || 'txt';
              const outPath = path.join('jobs', `${id}_result.${ext}`);
              fs.writeFileSync(outPath, text, 'utf8');
              finalize(outPath, mimeMap[ext] || 'text/plain');
              return;
            }
          }

          // Audio/video conversion
          if (mime.startsWith('audio/') || mime.startsWith('video/')) {
            setProgress(25, 'Converting media');
            const isAudio = mime.startsWith('audio/');
            const outExt = targetFormat || (isAudio ? 'mp3' : 'mp4');
            const outPath = path.join('jobs', `${id}_result.${outExt}`);

            await new Promise((resolve, reject) => {
              const proc = ffmpeg(filePath)
                .output(outPath)
                .outputOptions(['-preset veryfast', '-movflags +faststart'])
                .on('start', () => setProgress(30, 'ffmpeg started for conversion'))
                .on('progress', (p) => {
                  const percent = p.percent ? Math.min(85, 30 + Math.round(p.percent * 0.7)) : 30;
                  setProgress(percent, `Converting: ${Math.round(p.percent || 0)}%`);
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
            });

            finalize(outPath, mimeMap[outExt] || (isAudio ? `audio/${outExt}` : `video/${outExt}`));
            return;
          }

          // fallback: copy file
          const outPath = path.join('jobs', `${id}_result.${outExt}`);
          fs.copyFileSync(filePath, outPath);
          finalize(outPath, mimeMap[outExt] || 'application/octet-stream');
          return;
        }

        // If we reach here, unsupported action
        status.status = 'failed';
        status.message = 'Unsupported action or file type';
        writeStatus(id, status);
        cleanup(filePath);
        return;

      } catch (err) {
        // mark job failed
        status.status = 'failed';
        status.progress = 0;
        status.message = 'Processing error: ' + (err.message || String(err));
        writeStatus(id, status);
        try { cleanup(path.join('jobs', `${id}_result.*`)); } catch (e) {}
      }
    })();

    // Immediately respond with job id so client can poll
    res.json({ id });
  } catch (e) {
    console.error('❌ Processing failed:', e);
    res.status(500).json({ error: 'File processing failed: ' + e.message });
  }
});

// GET /status/:id -> return job status
router.get('/status/:id', (req, res) => {
  const id = req.params.id;
  const status = readStatus(id);
  if (!status) return res.status(404).json({ error: 'Job not found' });
  res.json(status);
});

// GET /download/:id -> stream file if done
router.get('/download/:id', (req, res) => {
  const id = req.params.id;
  const status = readStatus(id);
  if (!status) return res.status(404).json({ error: 'Job not found' });

  if (status.status !== 'done' || !status.outputPath || !fs.existsSync(status.outputPath)) {
    return res.status(400).json({ error: 'Job not ready for download' });
  }

  const outPath = status.outputPath;
  const filename = status.outputName || path.basename(outPath);
  const outMime = status.outputMime || 'application/octet-stream';

  res.setHeader('Content-Type', outMime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(outPath);
  stream.on('close', () => {
    // keep the output around for a short time; if you want auto-cleanup, do it here
  });
  stream.pipe(res);
});

// small util for escaping html in PDF->HTML fallback
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

module.exports = router;
