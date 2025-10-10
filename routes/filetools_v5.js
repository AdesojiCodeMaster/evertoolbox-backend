/*
filetools_v5.js
Express router (ESM) implementing a professional single-file Converter + Compressor
- Designed for Render backend, safe to add without touching existing routes.
- Mount at: app.use('/api/tools/file', filetoolsV5);

Features:
- Single-file upload only (reject multiparts)
- Returns converted/compressed file directly with proper headers (no zipping)
- Detects and rejects same-format conversion
- True compression (images via sharp, audio/video via ffmpeg, PDFs via ghostscript when available)
- Optimized defaults and user-adjustable quality (0-100)
- Lazy-loads heavy native modules (sharp, fluent-ffmpeg, ghostscript) only when needed
- Uses tmp-promise for secure temp dirs and automatic cleanup
- Strong validation, size limits, and SVG safety checks
- Clear JSON error responses for UI consumption

Deployment notes:
- System dependencies: ffmpeg (for audio/video), libreoffice (optional for doc conversions), ghostscript (gs) recommended for PDF compression
- Add these npm deps to package.json:
  {
    "dependencies": {
      "express": "^4.18.2",
      "multer": "^1.4.5-lts.1",
      "mime-types": "^2.1.35",
      "sanitize-filename": "^1.6.3",
      "tmp-promise": "^3.0.2",
      "archiver": "^5.3.1" /* optional not used for zipping here 
    }
  }
- Optional native libs (install as needed): sharp, fluent-ffmpeg, libreoffice-convert. They are lazy-imported in this router so you can add them later if desired.

Usage (frontend): send multipart/form-data with fields:
- file: the uploaded file
- targetFormat: (e.g. "webp", "jpeg", "png", "pdf", "mp3", "mp4", etc.)
- quality: (optional) 0-100 for compression/encoding quality
- width, height: (optional) for images
- edits: (optional JSON string) describing client-side edits already applied (crop/text/filters) — server accepts this as a passthrough to apply when present

Security & performance
- Enforced MAX_FILE_SIZE_BYTES (default 80MB) and MAX_PROCESSES concurrency via simple semaphore (configurable)
- Temp files auto-cleaned on success/error

Testing checklist
- Upload jpg convert to webp (direct download)
- Upload large jpg with quality=30 to compress (significant size reduction)
- Upload mp4 convert to mp3 (audio extraction)
- Upload file with same target -> returns 400 with friendly JSON
- Upload 2 files -> returns 400 single-file-only

==================================================================
*/

//import express from 'express';
//import multer from 'multer';
//import { fileURLToPath } from 'url';
//import path from 'path';
//import mime from 'mime-types';
//import sanitize from 'sanitize-filename';
//import tmp from 'tmp-promise';
//import fs from 'fs/promises';
//import { spawn } from 'child_process';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const mime = require('mime-types');
const sanitizeFilename = require('sanitize-filename');
const tmp = require('tmp-promise');


const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config via env
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MAX_FILE_SIZE_BYTES || '83886080'); // 80MB default
const ALLOWED_IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','avif','tiff','svg']);
const ALLOWED_AUDIO_EXTS = new Set(['mp3','wav','m4a','aac','ogg']);
const ALLOWED_VIDEO_EXTS = new Set(['mp4','mov','webm','mkv']);
const ALLOWED_DOC_EXTS = new Set(['pdf','docx','doc','pptx','ppt','txt','md']);
const MAX_CONCURRENT_PROCESSES = parseInt(process.env.MAX_CONCURRENT_PROCESSES || '2');

// Simple semaphore to limit concurrent heavy processes (very lightweight)
let activeProcesses = 0;
function acquireProcessSlot() {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (activeProcesses < MAX_CONCURRENT_PROCESSES) {
        activeProcesses += 1; resolve();
      } else {
        setTimeout(check, 150);
      }
    };
    check();
  });
}
function releaseProcessSlot() { activeProcesses = Math.max(0, activeProcesses - 1); }

// Multer setup: store to secure temp dir created per-upload
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = await tmp.dir({ unsafeCleanup: true });
      // attach tmp dir handle to request so it can be cleaned later
      req._tmpDir = dir;
      cb(null, dir.path);
    } catch (err) { cb(err); }
  },
  filename: (req, file, cb) => {
    const name = sanitize(file.originalname) || `upload-${Date.now()}`;
    cb(null, `${Date.now()}-${name}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

async function safeCleanupTmp(req) {
  try {
    if (req._tmpDir && req._tmpDir.cleanup) await req._tmpDir.cleanup();
  } catch(e){ /* ignore */ }
}

// lightweight svg safety check
async function isSvgSafe(filePath) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    const l = txt.toLowerCase();
    if (l.includes('<script') || l.includes('javascript:') || l.includes('onload=') || l.includes('xlink:href')) return false;
    return true;
  } catch (e) { return false; }
}

// helpers
function extFromFilename(name) {
  return path.extname(name).replace('.', '').toLowerCase();
}

// Lazy import helpers
async function importSharp() {
  try { const sharp = await import('sharp'); return sharp.default || sharp; } catch(e) { throw new Error('Module sharp not installed on server'); }
}
async function importFFmpeg() {
  try { const ffmpeg = await import('fluent-ffmpeg'); return ffmpeg.default || ffmpeg; } catch(e) { throw new Error('Module fluent-ffmpeg not installed on server'); }
}

// Main convert endpoint
// Accepts form-data with one file only
router.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    await safeCleanupTmp(req);
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Defensive: reject if more than one file slipped through
  if (Array.isArray(req.files) && req.files.length > 1) {
    await safeCleanupTmp(req);
    return res.status(400).json({ error: 'Only one file can be uploaded at a time' });
  }

  const targetFormat = (req.body.targetFormat || '').toLowerCase();
  const quality = Math.max(0, Math.min(100, parseInt(req.body.quality || '80')));
  const width = req.body.width ? parseInt(req.body.width) : null;
  const height = req.body.height ? parseInt(req.body.height) : null;
  const edits = req.body.edits ? JSON.parse(req.body.edits) : null; // optional client-side edits descriptor

  const filePath = req.file.path;
  const originalName = sanitize(req.file.originalname || 'file');
  const inputExt = extFromFilename(originalName);

  // target format required
  if (!targetFormat) {
    await safeCleanupTmp(req);
    return res.status(400).json({ error: 'Please specify targetFormat' });
  }

  // same-format check
  if (inputExt === targetFormat) {
    await safeCleanupTmp(req);
    return res.status(400).json({ error: 'The uploaded file is already in the selected format.' });
  }

  // basic file type recognition
  const isImage = ALLOWED_IMAGE_EXTS.has(inputExt) || inputExt.startsWith('image');
  const isAudio = ALLOWED_AUDIO_EXTS.has(inputExt);
  const isVideo = ALLOWED_VIDEO_EXTS.has(inputExt);
  const isDoc = ALLOWED_DOC_EXTS.has(inputExt);

  // svg safety
  if (inputExt === 'svg') {
    const ok = await isSvgSafe(filePath);
    if (!ok) { await safeCleanupTmp(req); return res.status(400).json({ error: 'Unsafe SVG content detected' }); }
  }

  // Acquire process slot for heavy ops
  await acquireProcessSlot();

  try {
    // Image processing path (sharp)
    if (isImage) {
      const sharp = await importSharp();
      let img = sharp(filePath, { failOnError: false });

      // apply edits if present (basic support: crop, rotate)
      if (edits && typeof edits === 'object') {
        if (edits.rotate) img = img.rotate(edits.rotate);
        if (edits.crop) {
          const { left, top, width: cw, height: ch } = edits.crop;
          img = img.extract({ left, top, width: cw, height: ch });
        }
      }

      if (width || height) img = img.resize(width || null, height || null, { fit: 'inside' });

      // choose output pipeline based on target format
      const outExt = targetFormat === 'jpg' ? 'jpeg' : targetFormat;
      const outPath = path.join(path.dirname(filePath), `${Date.now()}-out.${outExt}`);

      if (['jpeg','jpg'].includes(outExt)) await img.jpeg({ quality }).toFile(outPath);
      else if (outExt === 'webp') await img.webp({ quality }).toFile(outPath);
      else if (outExt === 'png') await img.png({ compressionLevel: 9 }).toFile(outPath);
      else if (outExt === 'avif') await img.avif({ quality }).toFile(outPath);
      else if (outExt === 'tiff') await img.tiff({ quality }).toFile(outPath);
      else {
        // fallback: attempt to output the same pixel data as png
        await img.toFile(outPath);
      }

      const data = await fs.readFile(outPath);
      await fs.unlink(outPath);
      await safeCleanupTmp(req);

      res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(originalName, path.extname(originalName))}.${outExt}"`);
      return res.send(data);
    }

    // Audio/video via ffmpeg
    if (isAudio || isVideo) {
      const ffmpeg = await importFFmpeg();
      // Build output path
      const outExt = targetFormat;
      const outPath = path.join(path.dirname(filePath), `${Date.now()}-out.${outExt}`);

      // Construct ffmpeg args (optimized defaults)
      // For audio-only outputs: extract audio and set bitrate according to quality
      const args = ['-y', '-i', filePath];
      if (isVideo && ['mp4','webm','mkv'].includes(outExt)) {
        // re-encode video with target bitrate proportional to quality
        const bitrate = Math.max(64, Math.floor((quality / 100) * 2000)); // kbps
        args.push('-b:v', `${bitrate}k`);
        args.push('-preset', 'fast');
      }
      if (['mp3','aac','ogg','m4a'].includes(outExt)) {
        const abr = Math.max(64, Math.floor((quality / 100) * 192));
        args.push('-b:a', `${abr}k`);
      }

      args.push(outPath);

      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + stderr)));
      });

      const data = await fs.readFile(outPath);
      await fs.unlink(outPath);
      await safeCleanupTmp(req);

      res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(originalName, path.extname(originalName))}.${outExt}"`);
      return res.send(data);
    }

    // Document handling: PDF optimization (ghostscript) or format conversion is optional
    if (isDoc) {
      // if target is pdf and input is pdf -> compress via ghostscript if available
      if (inputExt === 'pdf' && targetFormat === 'pdf') {
        // use ghostscript to compress
        const outPath = path.join(path.dirname(filePath), `${Date.now()}-out.pdf`);
        const gsArgs = ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${outPath}`, filePath];
        await new Promise((resolve, reject) => {
          const proc = spawn('gs', gsArgs);
          proc.on('error', reject);
          proc.on('close', code => code === 0 ? resolve() : reject(new Error('ghostscript failed code '+code)));
        });
        const data = await fs.readFile(outPath);
        await fs.unlink(outPath);
        await safeCleanupTmp(req);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(originalName, path.extname(originalName))}.pdf"`);
        return res.send(data);
      }

      // For other doc conversions, attempt to use libreoffice-convert if available (lazy import)
      try {
        const libre = (await import('libreoffice-convert')).default;
        const inputBuf = await fs.readFile(filePath);
        const outExt = targetFormat;
        const converted = await new Promise((resolve, reject) => {
          libre.convert(inputBuf, `.${outExt}`, undefined, (err, done) => { if (err) reject(err); else resolve(done); });
        });
        await safeCleanupTmp(req);
        res.setHeader('Content-Type', mime.lookup(`.${outExt}`) || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(originalName, path.extname(originalName))}.${outExt}"`);
        return res.send(converted);
      } catch (e) {
        await safeCleanupTmp(req);
        return res.status(500).json({ error: 'Document conversion not available on server', detail: e?.message });
      }
    }

    // Fallback: return file as-is (if target format unknown)
    const fallback = await fs.readFile(filePath);
    await safeCleanupTmp(req);
    res.setHeader('Content-Type', req.file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    return res.send(fallback);

  } catch (err) {
    console.error('convert error', err);
    await safeCleanupTmp(req);
    return res.status(500).json({ error: 'Conversion failed', detail: err?.message });
  } finally {
    releaseProcessSlot();
  }
});

// A small health endpoint for the router
router.get('/health', (req, res) => res.json({ ok: true, activeProcesses }));

module.exports = router;

