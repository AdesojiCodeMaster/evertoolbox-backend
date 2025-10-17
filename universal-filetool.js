// universal-filetool.js
// Simple file conversion + compression backend with job status & download
// Usage: node universal-filetool.js
// Ensure ffmpeg is installed on the host for video/audio work.

const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const mime = require('mime-types');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TMP_ROOT = path.join(__dirname, 'tmp_jobs');
fs.ensureDirSync(TMP_ROOT);

// Multer config - limit file size (e.g., 200MB)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_ROOT),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`)
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

const jobs = new Map(); // jobId -> metadata

// Utility
function sanitizeFilename(name) {
  return name.replace(/[^\w.\-() ]+/g, '_');
}

function setJobError(jobId, errMsg) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'error';
    job.progress = 100;
    job.message = errMsg;
    job.updatedAt = Date.now();
  }
}

function scheduleCleanup(jobId, ms = 5 * 60 * 1000) { // default 5 minutes after done/error
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(async () => {
    try {
      await fs.remove(job.dir);
    } catch (e) {}
    jobs.delete(jobId);
  }, ms);
}

// POST /api/upload?action=convert|compress&targetFormat=png|jpg|mp4|mp3...
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const action = (req.query.action || req.body.action || '').toLowerCase();
    const targetFormat = (req.query.targetFormat || req.body.targetFormat || '').toLowerCase();

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!['convert', 'compress'].includes(action)) {
      await fs.remove(req.file.path);
      return res.status(400).json({ error: 'Invalid action. Use "convert" or "compress".' });
    }

    const jobId = uuidv4();
    const jobDir = path.join(TMP_ROOT, jobId);
    await fs.ensureDir(jobDir);

    const originalName = sanitizeFilename(req.file.originalname);
    const inputPath = path.join(jobDir, 'input' + path.extname(originalName));
    await fs.move(req.file.path, inputPath);

    const job = {
      id: jobId,
      status: 'queued',
      message: 'Queued',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dir: jobDir,
      inputPath,
      originalName,
      outputPath: null,
      action,
      targetFormat
    };
    jobs.set(jobId, job);

    // Start processing async
    processNext(job).catch(err => {
      console.error('Processing error', err);
      setJobError(jobId, String(err));
      scheduleCleanup(jobId);
    });

    res.json({ jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    progress: job.progress,
    originalName: job.originalName,
    outputFilename: job.outputFilename || null
  });
});

app.get('/api/download/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done' || !job.outputPath) return res.status(400).json({ error: 'Output not ready' });

  // Stream file and schedule cleanup
  const stat = await fs.stat(job.outputPath);
  res.setHeader('Content-Length', stat.size);
  const downloadName = job.outputFilename || path.basename(job.outputPath);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const readStream = fs.createReadStream(job.outputPath);
  readStream.pipe(res);

  // After streaming completes, cleanup the job directory after a short delay
  readStream.on('end', () => {
    scheduleCleanup(job.id, 30 * 1000); // remove after 30s
  });
  readStream.on('error', () => {
    scheduleCleanup(job.id, 30 * 1000);
  });
});

// Processing logic
async function processNext(job) {
  job.status = 'processing';
  job.progress = 5;
  job.message = 'Starting processing';
  job.updatedAt = Date.now();

  const inputExt = path.extname(job.inputPath).slice(1).toLowerCase();
  const target = (job.targetFormat || '').toLowerCase();
  const mimeType = mime.lookup(job.inputPath) || '';

  const isImage = /^image\//.test(mimeType) || ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'avif', 'gif'].includes(inputExt);
  const isVideo = /^video\//.test(mimeType) || ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(inputExt);
  const isAudio = /^audio\//.test(mimeType) || ['mp3', 'wav', 'ogg', 'm4a'].includes(inputExt);

  try {
    if (job.action === 'convert') {
      if (!target) throw new Error('targetFormat is required for convert');
      if (isImage) {
        await convertImage(job, target);
      } else if (isVideo || isAudio) {
        await convertMediaWithFFMPEG(job, target);
      } else {
        throw new Error('Unsupported input type for convert');
      }
    } else if (job.action === 'compress') {
      // Compression: for images we adjust quality; for video we'll set CRF
      if (isImage) {
        await compressImage(job, job.targetFormat); // targetFormat optional: use same ext
      } else if (isVideo) {
        await compressVideo(job);
      } else {
        throw new Error('Unsupported input type for compress');
      }
    } else {
      throw new Error('Unknown action');
    }

    job.status = 'done';
    job.progress = 100;
    job.message = 'Done';
    job.updatedAt = Date.now();
    scheduleCleanup(job.id, 5 * 60 * 1000);
  } catch (err) {
    console.error('Processing error', err);
    setJobError(job.id, String(err));
    scheduleCleanup(job.id);
    throw err;
  }
}

async function convertImage(job, targetFormat) {
  const outName = path.basename(job.originalName, path.extname(job.originalName)) + '.' + targetFormat.replace(/^\./, '');
  const outPath = path.join(job.dir, outName);
  job.message = 'Converting image';
  job.progress = 15;
  job.outputFilename = outName;

  // Default to reasonable options; if converting to jpeg, set quality 85.
  let pipeline = sharp(job.inputPath);
  if (['jpg', 'jpeg'].includes(targetFormat)) {
    pipeline = pipeline.jpeg({ quality: 85 });
  } else if (targetFormat === 'png') {
    pipeline = pipeline.png({ compressionLevel: 8 });
  } else if (targetFormat === 'webp') {
    pipeline = pipeline.webp({ quality: 85 });
  } else if (targetFormat === 'avif') {
    pipeline = pipeline.avif({ quality: 50 });
  }

  await pipeline.toFile(outPath);
  job.outputPath = outPath;
  job.progress = 90;
  job.message = 'Image conversion complete';
  job.updatedAt = Date.now();
}

async function compressImage(job, preferredTarget) {
  // compress image into same format or preferred target
  const ext = preferredTarget ? preferredTarget.replace(/^\./, '') : path.extname(job.inputPath).slice(1);
  const outName = path.basename(job.originalName, path.extname(job.originalName)) + '.' + ext;
  const outPath = path.join(job.dir, outName);
  job.message = 'Compressing image';
  job.progress = 20;
  job.outputFilename = outName;

  // Heuristic: set quality lower than convert
  let pipeline = sharp(job.inputPath);
  if (['jpg', 'jpeg'].includes(ext)) {
    pipeline = pipeline.jpeg({ quality: 65 });
  } else if (ext === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else if (ext === 'webp') {
    pipeline = pipeline.webp({ quality: 65 });
  } else {
    // fallback: re-encode to jpeg
    pipeline = pipeline.jpeg({ quality: 65 });
  }

  await pipeline.toFile(outPath);
  job.outputPath = outPath;
  job.progress = 95;
  job.message = 'Image compression complete';
  job.updatedAt = Date.now();
}

function convertMediaWithFFMPEG(job, targetFormat) {
  return new Promise((resolve, reject) => {
    const targetExt = targetFormat.replace(/^\./, '') || (path.extname(job.inputPath).slice(1));
    const outName = path.basename(job.originalName, path.extname(job.originalName)) + '.' + targetExt;
    const outPath = path.join(job.dir, outName);
    job.outputFilename = outName;
    job.message = 'Converting media with ffmpeg';
    job.progress = 25;
    job.updatedAt = Date.now();

    const command = ffmpeg(job.inputPath)
      .on('start', cmd => {
        job.message = 'FFmpeg started';
        job.progress = 30;
        job.updatedAt = Date.now();
      })
      .on('progress', progress => {
        // progress.percent isn't always available; derive an estimated percent
        if (progress && progress.percent) {
          job.progress = Math.min(95, Math.floor(30 + progress.percent * 0.6));
        } else {
          job.progress = Math.min(90, job.progress + 2);
        }
        job.updatedAt = Date.now();
      })
      .on('end', () => {
        job.outputPath = outPath;
        job.progress = 98;
        job.message = 'FFmpeg finished';
        job.updatedAt = Date.now();
        resolve();
      })
      .on('error', err => {
        reject(err);
      })
      .outputOptions('-y'); // overwrite
    // tune outputs based on extension
    if (['mp4', 'mov', 'mkv', 'webm'].includes(targetExt)) {
      // copy video codec if possible, otherwise transcode to libx264
      command.videoCodec('libx264').audioCodec('aac').format(targetExt);
    } else if (['mp3', 'wav', 'aac', 'ogg'].includes(targetExt)) {
      command.noVideo().audioCodec('libmp3lame').format(targetExt);
    } else {
      // fallback use container / try to transcode
      command.format(targetExt);
    }
    command.save(outPath);
  });
}

function compressVideo(job) {
  return new Promise((resolve, reject) => {
    const inPath = job.inputPath;
    const outName = path.basename(job.originalName, path.extname(job.originalName)) + '.mp4';
    const outPath = path.join(job.dir, outName);
    job.outputFilename = outName;
    job.message = 'Compressing video';
    job.progress = 20;
    job.updatedAt = Date.now();

    const command = ffmpeg(inPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset veryfast',
        '-crf 28', // higher crf -> smaller file, lower quality
        '-movflags +faststart'
      ])
      .on('start', () => {
        job.progress = 30;
        job.updatedAt = Date.now();
      })
      .on('progress', p => {
        if (p && p.percent) {
          job.progress = Math.min(95, Math.floor(30 + p.percent * 0.6));
        } else {
          job.progress = Math.min(90, job.progress + 3);
        }
        job.updatedAt = Date.now();
      })
      .on('end', () => {
        job.outputPath = outPath;
        job.progress = 98;
        job.message = 'Video compression complete';
        job.updatedAt = Date.now();
        resolve();
      })
      .on('error', err => {
        reject(err);
      })
      .save(outPath);
  });
}

//const PORT = process.env.PORT || 3000;
//app.listen(PORT, () => {
  //console.log(`Universal file tool server listening on port ${PORT}`);
  //console.log(`Temporary job dir: ${TMP_ROOT}`);
});
         
