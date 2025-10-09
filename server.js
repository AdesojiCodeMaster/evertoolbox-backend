// server.js (CommonJS) - EverToolbox backend (complete)
// Usage: node server.js
// NOTE: For document conversions this uses "soffice" (LibreOffice) which must be installed on the host.

//const express = require('express');
//const multer = require('multer');
// const fetch = require('node-fetch'); // v2 style require
//const cheerio = require('cheerio');
//const fs = require('fs');
//const path = require('path');
//const archiver = require('archiver');
//const unzipper = require('unzipper');
//const { exec } = require('child_process');
//const sharp = require('sharp');
//const googleTTS = require('google-tts-api'); // generate base64 audio
//const cors = require('cors');
//const { v4: uuidv4 } = require('uuid');



import fetch from "node-fetch";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import { exec } from "child_process";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as cheerio from "cheerio";
import unzipper from "unzipper";
import googleTTS from "google-tts-api";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { franc } from 'franc';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// simple safe filename sanitizer (no external dependency)
const sanitize = (name = "") => name.replace(/[^a-zA-Z0-9._-]/g, "_");
//çonst safeFilename = sanitize;





const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

// storage
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random()*1e6)}-${file.originalname}`;
    cb(null, unique);
  }
});
const upload = multer({ storage });

// --------------------
// Helpers
// --------------------
function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

// Serve simple root
app.get('/', (req, res) => {
  res.send('EverToolbox Backend is running ✅');
});

// --------------------
// 1) SEO Analyzer
// GET /api/seo-analyze?url=<url>
// --------------------
app.get('/api/seo-analyze', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url query parameter' });

  try {
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return res.status(r.status).json({ error: `Failed to fetch URL: ${r.status}` });
    const html = await r.text();
    const $ = cheerio.load(html);

    const title = $('title').text() || '';
    const description = $('meta[name="description"]').attr('content') || '';
    const issues = [];
    if (title.length < 30 || title.length > 65) issues.push('Title length should be 30–65 characters.');
    if (description.length < 70 || description.length > 160) issues.push('Meta description should be 70–160 characters.');

    return res.json({ title, description, issues });
  } catch (err) {
    console.error('SEO analyze failed', err);
    return res.status(500).json({ error: 'Failed to analyze page.' });
  }
});

// --------------------
// 2) Text-to-Speech (TTS)
// POST /api/tts  body: { text: "...", lang: "en" }
// returns audio/mpeg (MP3)
// --------------------

// --- TTS endpoint with translation + speech ---
// Place this near other routes in your server.js


//const { franc } = require('franc');
// ====== TTS Handler (OpenAI + Google fallback) ======
   
 app.post('/api/tts', async (req, res) => {
  try {
    const { text, lang } = req.body;
    if (!text || !lang) {
      return res.status(400).json({ error: 'Missing text or lang' });
    }

    // Step 1: Translate text to target language using Google Translate endpoint
    const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
    const translateResp = await fetch(translateUrl);
    const translateData = await translateResp.json();

    const translatedText = translateData[0]?.map(x => x[0]).join(' ');
    if (!translatedText) {
      return res.status(500).json({ error: 'Translation failed' });
    }

    console.log(`Translated to [${lang}]:`, translatedText);

    // Step 2: Generate TTS from translated text
    const googleTTS = await import('google-tts-api');
    const url = googleTTS.getAudioUrl(translatedText, {
      lang,
      slow: false,
      host: 'https://translate.google.com',
    });

    // Step 3: Fetch MP3 and send it back
    const audioResp = await fetch(url);
    const audioBuf = await audioResp.arrayBuffer();

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="speech.mp3"',
    });
    res.send(Buffer.from(audioBuf));
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});
      




// --------------------
// 3) Document conversion (uses LibreOffice 'soffice')
// POST /api/convert-doc  form-data: file=...  + field targetExt (e.g. .pdf or pdf)
// returns converted file for download
// --------------------
app.post('/api/convert-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let target = req.body.targetExt || req.query.targetExt || req.body.target || req.query.target || 'pdf';
    // normalize
    if (target.startsWith('.')) target = target.slice(1);
    const inputPath = req.file.path;
    const inputName = req.file.filename;
    const outDir = UPLOAD_DIR;
    const cmd = `soffice --headless --convert-to ${target} --outdir ${outDir} ${inputPath}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('LibreOffice convert error', err, stderr);
        // cleanup input file
        try { fs.unlinkSync(inputPath); } catch(e) {}
        return res.status(500).json({ error: 'Document conversion failed on server. Ensure LibreOffice is installed.' });
      }
      // LibreOffice outputs file with same base name but new ext
      const base = inputName.replace(/\.[^/.]+$/, '');
      const outputFile = path.join(outDir, `${base}.${target}`);
      if (!fs.existsSync(outputFile)) {
        // maybe soffice used a different name, try to find matching file modified recently
        const found = fs.readdirSync(outDir).filter(f => f.includes(base) && f.endsWith(`.${target}`))[0];
        if (found) {
          return res.download(path.join(outDir, found), found, (errDown) => {
            try { fs.unlinkSync(inputPath); } catch(e) {}
            try { fs.unlinkSync(path.join(outDir, found)); } catch(e) {}
          });
        } else {
          try { fs.unlinkSync(inputPath); } catch(e) {}
          return res.status(500).json({ error: 'Converted file not found.' });
        }
      }
      // send file and cleanup
      res.download(outputFile, path.basename(outputFile), (errDown) => {
        try { fs.unlinkSync(inputPath); } catch(e) {}
        try { fs.unlinkSync(outputFile); } catch(e) {}
      });
    });
  } catch (err) {
    console.error('convert-doc error', err);
    return res.status(500).json({ error: 'Server conversion failed' });
  }
});

// --------------------
// 4) Image conversion & simple editor via Sharp
// POST /api/convert-image  form-data: file=...   optional query or body: format=png|jpeg|webp , width, height, brightness (-100..100), overlayText, overlayColor, overlayOpacity, fontSize
// returns image binary
// --------------------
app.post('/api/convert-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const format = (req.body.format || req.query.format || 'png').toLowerCase();
    const width = req.body.width || req.query.width ? parseInt(req.body.width || req.query.width) : null;
    const height = req.body.height || req.query.height ? parseInt(req.body.height || req.query.height) : null;
    const brightness = req.body.brightness || req.query.brightness ? parseInt(req.body.brightness || req.query.brightness) : 0;
    const overlayText = req.body.overlayText || req.query.overlayText || '';
    const overlayColor = req.body.overlayColor || req.query.overlayColor || '#000000';
    const overlayOpacity = req.body.overlayOpacity || req.query.overlayOpacity ? parseFloat(req.body.overlayOpacity || req.query.overlayOpacity) : 0;
    const fontSize = req.body.fontSize || req.query.fontSize ? parseInt(req.body.fontSize || req.query.fontSize) : 36;

    let img = sharp(req.file.path, { failOnError: false });
    if (width || height) img = img.resize(width || null, height || null, { fit: 'inside' });
    if (brightness && brightness !== 0) {
      const mul = 1 + (brightness / 100);
      img = img.modulate({ brightness: mul });
    }

    let buffer = await img.toBuffer();

    // overlay text if requested using SVG composite
    if (overlayText && overlayText.trim()) {
      const meta = await sharp(buffer).metadata();
      const svg = `<svg width="${meta.width}" height="${meta.height}">
        <rect width="100%" height="100%" fill="rgba(0,0,0,0)" />
        <style>
          .t { fill: ${overlayColor}; font-size: ${fontSize}px; font-family: sans-serif; text-anchor: middle; dominant-baseline: middle;}
        </style>
        <text x="50%" y="50%" class="t">${escapeXml(overlayText)}</text>
      </svg>`;
      buffer = await sharp(buffer).composite([{ input: Buffer.from(svg), gravity: 'center' }]).toBuffer();
    }

    // convert format
    let outBuf;
    if (format === 'jpeg' || format === 'jpg') {
      outBuf = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      res.type('jpeg');
    } else if (format === 'webp') {
      outBuf = await sharp(buffer).webp({ quality: 90 }).toBuffer();
      res.type('webp');
    } else {
      outBuf = await sharp(buffer).png().toBuffer();
      res.type('png');
    }

    // cleanup uploaded file
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.send(outBuf);
  } catch (err) {
    console.error('convert-image error', err);
    try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: 'Image conversion failed' });
  }
});

// escape xml for svg insertion
function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// --------------------
// 5) Zip: create zip from uploaded files
// POST /api/zip form-data with files: files (multiple)
// returns zip
// --------------------
app.post('/api/zip', upload.array('files'), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const zipName = `archive-${Date.now()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send({ error: err.message }));
  archive.pipe(res);
  req.files.forEach(f => {
    archive.file(f.path, { name: f.originalname });
  });
  archive.finalize();
  // Note: files will remain in uploads; consider a cleanup job. For now we keep them for safety.
});

// --------------------
// 6) Unzip: accept zip, extract to temp folder and return list + download links
// POST /api/unzip form-data: file=zip
// returns { id: "<id>", files: [ {name, url} ] }
// ---- GET /api/temp/:id/:filename to download
// --------------------
app.post('/api/unzip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip uploaded' });
  const id = uuidv4();
  const extractDir = path.join(UPLOAD_DIR, `unzip-${id}`);
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    await fs.createReadStream(req.file.path).pipe(unzipper.Extract({ path: extractDir })).promise();
    // remove uploaded zip
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    const files = fs.readdirSync(extractDir).map(name => ({ name, url: `/api/temp/${id}/${encodeURIComponent(name)}` }));
    return res.json({ id, files });
  } catch (err) {
    console.error('unzip error', err);
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e){}
    return res.status(500).json({ error: 'Failed to unzip' });
  }
});

// Serve extracted files
app.get('/api/temp/:id/:filename', (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  const dir = path.join(UPLOAD_DIR, `unzip-${id}`);
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, filename, (err) => {
    if (err) console.error('temp download error', err);
    // optionally: delete after download -- we won't auto-delete to avoid race conditions
  });
});







// ------------------------------
// START: EverToolbox v2 Routes
// ------------------------------








//const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  


/* ===========================================================
   1. FILE CONVERTER + COMPRESSION + WATERMARK (final version)
   =========================================================== */

/* ============================
  FINAL /api/v3/file/convert
  and /api/v3/file/compress
  (paste to replace existing v3 route blocks)
   - Uses pdfkit + mammoth + sharp + pdf-lib
   - Keeps file extensions; compression uses 90-95% quality
============================ */

app.post("/api/v3/file/convert", upload.single("file"), async (req, res) => {
  try {
    console.log("[v3/convert] request:", req.file && req.file.originalname, req.body);
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { outputFormat, watermark, renameTo } = req.body || {};
    const inputPath = req.file.path;
    const originalName = req.file.originalname;
    const inputExt = path.extname(originalName).slice(1).toLowerCase();
    const baseName = path.basename(originalName, path.extname(originalName));
    const finalExt = (outputFormat || inputExt || "").replace(/^\./, "").toLowerCase();
    const finalName = (renameTo && String(renameTo).trim()) || `${baseName}.${finalExt}`;

    // Helper to send buffer and cleanup input
    const sendBuffer = (buf, mime, filename) => {
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
      try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
      return res.end(buf);
    };

    // -------------------------
    // TXT -> PDF (pdfkit, A4, Helvetica)
    // -------------------------
    if (inputExt === "txt" && finalExt === "pdf") {
      const pdfkitMod = await import("pdfkit");
      const PDFDocumentKit = pdfkitMod.default || pdfkitMod;
      const text = fs.readFileSync(inputPath, "utf8");
      const doc = new PDFDocumentKit({ size: "A4", margin: 48 });
      doc.font("Helvetica");
      // stream into buffer
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => {
        const out = Buffer.concat(chunks);
        return sendBuffer(out, "application/pdf", finalName);
      });
      // write text with basic wrap
      const lines = text.replace(/\r/g, "").split(/\n/);
      lines.forEach((ln) => { doc.text(ln, { lineGap: 4 }); });
      doc.end();
      return;
    }

    // -------------------------
    // DOCX -> PDF (mammoth -> text -> pdfkit)
    // -------------------------
    if (["docx"].includes(inputExt) && finalExt === "pdf") {
      const mammoth = (await import("mammoth")).default || (await import("mammoth"));
      const pdfkitMod = await import("pdfkit");
      const PDFDocumentKit = pdfkitMod.default || pdfkitMod;
      try {
        const result = await mammoth.extractRawText({ path: inputPath });
        const text = result.value || "";
        const doc = new PDFDocumentKit({ size: "A4", margin: 48 });
        doc.font("Helvetica");
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => {
          const out = Buffer.concat(chunks);
          return sendBuffer(out, "application/pdf", finalName);
        });
        const lines = text.replace(/\r/g, "").split(/\n/);
        lines.forEach((ln) => { doc.text(ln, { lineGap: 4 }); });
        doc.end();
        return;
      } catch (err) {
        console.error("[v3/convert] DOCX->PDF error:", err);
        try { fs.unlinkSync(inputPath); } catch(e) {}
        return res.status(500).json({ error: "DOCX -> PDF conversion failed." });
      }
    }

    // -------------------------
    // Image input: image -> image/pdf
    // -------------------------
    if (["jpg", "jpeg", "png", "webp", "avif", "tiff"].includes(inputExt)) {
      let img = sharp(inputPath, { failOnError: false });

      // watermark overlay (SVG)
      if (watermark && String(watermark).trim()) {
        const meta = await img.metadata();
        const svg = `<svg width="${meta.width}" height="${meta.height}">
          <text x="50%" y="${Math.round(meta.height * 0.95)}" font-size="36" text-anchor="middle" fill="rgba(255,255,255,0.6)">${escapeXml(String(watermark))}</text>
        </svg>`;
        img = img.composite([{ input: Buffer.from(svg), gravity: "south" }]);
      }

      // image -> pdf
      if (finalExt === "pdf") {
        // pdfkit can embed images but sharp can create a PDF buffer directly using a PNG/JPEG input
        // create PNG buffer and embed in PDF via pdfkit
        const pngBuf = await img.png({ quality: 95 }).toBuffer();
        const pdfkitMod = await import("pdfkit");
        const PDFDocumentKit = pdfkitMod.default || pdfkitMod;
        const doc = new PDFDocumentKit({ autoFirstPage: false });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => {
          const out = Buffer.concat(chunks);
          return sendBuffer(out, "application/pdf", finalName);
        });
        const meta = await sharp(pngBuf).metadata();
        doc.addPage({ size: [meta.width, meta.height], margin: 0 });
        doc.image(pngBuf, 0, 0, { width: meta.width, height: meta.height });
        doc.end();
        return;
      }

      // image -> image (keep same type if requested)
      if (["jpg", "jpeg", "png", "webp"].includes(finalExt)) {
        const fmt = finalExt === "jpg" ? "jpeg" : finalExt;
        // quality 90-95 as requested
        const outBuf = await img.toFormat(fmt, { quality: 92 }).toBuffer();
        const mime = fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`;
        return sendBuffer(outBuf, mime, finalName);
      }

      return res.status(400).json({ error: "Unsupported target format for image input." });
    }

    // -------------------------
    // PDF input: watermark only (or unsupported conversions)
    // -------------------------
    if (inputExt === "pdf") {
      const pdfBuf = fs.readFileSync(inputPath);

      if (watermark && String(watermark).trim()) {
        const pdfDoc = await PDFDocument.load(pdfBuf);
        const pages = pdfDoc.getPages();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        for (const page of pages) {
          const { width, height } = page.getSize();
          page.drawText(String(watermark), {
            x: width / 2 - (String(watermark).length * 3),
            y: height / 2,
            size: 36,
            font,
            color: rgb(0.8, 0.8, 0.8),
            rotate: { degrees: 45 },
          });
        }
        const out = await pdfDoc.save();
        return sendBuffer(Buffer.from(out), "application/pdf", finalName);
      }

      return res.status(400).json({ error: "PDF input: specify a watermark or use another endpoint for conversion." });
    }

    // -------------------------
    // Unsupported input fallback
    // -------------------------
    return res.status(400).json({ error: "Unsupported input file type for conversion on this endpoint." });

  } catch (err) {
    console.error("[v3/convert] error:", err);
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ error: "File conversion failed.", details: err.message });
  }
});



/* ============================
   FINAL /api/v3/file/compress
   - Keeps same extension
   - Images compressed at 92% quality by default (90-95 requested)
   - PDF lightly rewritten (pdf-lib) which often reduces size
============================ */
app.post("/api/v3/file/compress", upload.single("file"), async (req, res) => {
  try {
    console.log("[v3/compress] request:", req.file && req.file.originalname, req.body);
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const inputPath = req.file.path;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName).slice(1).toLowerCase();
    const baseName = path.basename(originalName, path.extname(originalName));

    // default quality target 92 (user requested 90-95 visible & clear)
    const quality = Math.max(70, Math.min(parseInt(req.body.quality || "92", 10), 95));

    // Images: compress and keep same extension
    if (["jpg", "jpeg", "png", "webp", "avif", "tiff"].includes(ext)) {
      const fmt = (ext === "jpg") ? "jpeg" : ext;
      // For PNG: try to compress as PNG with quality-like options; sharp's png compression is limited,
      // so use png -> png with compressionLevel, but keep it same ext.
      let outBuf;
      if (fmt === "png") {
        // PNG: reduce dimensions slightly if large to save bytes while keeping quality
        const meta = await sharp(inputPath).metadata();
        let transformer = sharp(inputPath, { failOnError: false }).png({ compressionLevel: 6 });
        // if image is very large, downscale to max 2000px
        const maxDim = Math.max(meta.width || 0, meta.height || 0);
        if (maxDim > 2000) transformer = transformer.resize({ width: 2000, height: null, fit: "inside" });
        outBuf = await transformer.toBuffer();
      } else {
        // jpeg/webp/avif: set quality
        const transformer = sharp(inputPath, { failOnError: false }).toFormat(fmt, { quality });
        outBuf = await transformer.toBuffer();
      }

      // cleanup and return
      try { fs.unlinkSync(inputPath); } catch (e) {}
      const outName = `${baseName}_compressed.${ext === "jpeg" ? "jpg" : ext}`;
      const mime = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : `image/${ext}`;
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(outName)}"`);
      return res.end(outBuf);
    }

    // PDF: re-save with pdf-lib (light rewrite, sometimes reduces size)
    if (ext === "pdf") {
      const buf = fs.readFileSync(inputPath);
      const pdfDoc = await PDFDocument.load(buf);
      // no changes, just re-save using object streams to be slightly more optimized
      const out = await pdfDoc.save({ useObjectStreams: true });
      try { fs.unlinkSync(inputPath); } catch (e) {}
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(baseName + "_compressed.pdf")}"`);
      return res.end(Buffer.from(out));
    }

    // Fallback (rare): archive original in zip (only when we can't compress)
    const zipName = `${baseName}_compressed.zip`;
    const zipPath = path.join(UPLOAD_DIR, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);
    archive.file(inputPath, { name: originalName });
    await archive.finalize();
    output.on("close", () => {
      res.download(zipPath, zipName, (err) => {
        try { fs.unlinkSync(inputPath); } catch (e) {}
        try { fs.unlinkSync(zipPath); } catch (e) {}
        if (err) console.error("[v3/compress] download error:", err);
      });
    });

  } catch (err) {
    console.error("[v3/compress] error:", err);
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ error: "Compression failed.", details: err.message });
  }
});
  
      

/* ===========================================================
   2. IMAGE CONVERTER / THUMBNAIL GENERATOR
   =========================================================== */
app.post("/api/v2/image/process", upload.single("image"), async (req, res) => {
  try {
    const {
      format = "png",
      width,
      height,
      quality = 80,
      ratioPreset,
      bgColor,
      textOverlay,
    } = req.body;

    const inputPath = req.file.path;
    const outputName = Date.now() + "." + format;
    const outputPath = path.join(UPLOAD_DIR, outputName);

    let image = sharp(inputPath);

    if (ratioPreset) {
      const [wRatio, hRatio] = ratioPreset.split(":").map(Number);
      const metadata = await image.metadata();
      const newWidth = metadata.width;
      const newHeight = Math.round((newWidth * hRatio) / wRatio);
      image = image.resize(newWidth, newHeight, { fit: "cover" });
    }

    if (width && height) image = image.resize(parseInt(width), parseInt(height));
    if (bgColor) image = image.flatten({ background: bgColor });
    if (textOverlay) {
      // Simple text overlay: optional SVG-based watermark
      const svgText = `
        <svg width="500" height="100">
          <rect x="0" y="0" width="100%" height="100%" fill="none"/>
          <text x="10" y="60" font-size="40" fill="white" opacity="0.6">${textOverlay}</text>
        </svg>`;
      image = image.composite([{ input: Buffer.from(svgText), gravity: "southeast" }]);
    }

    await image.toFormat(format, { quality: parseInt(quality) }).toFile(outputPath);

    res.download(outputPath, () => fs.unlinkSync(outputPath));
  } catch (err) {
    console.error(err);
    res.status(500).send("Image processing failed.");
  }
});

/* ===========================================================
   3. ZIP / UNZIP TOOL
   =========================================================== */
app.post("/api/v2/zip", upload.array("files"), async (req, res) => {
  try {
    const zipName = `archive-${Date.now()}.zip`;
    const zipPath = path.join(UPLOAD_DIR, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);

    req.files.forEach((file) => archive.file(file.path, { name: file.originalname }));
    await archive.finalize()

    output.on("close", () => {
      res.download(zipPath, () => {
        fs.unlinkSync(zipPath);
        req.files.forEach((file) => fs.unlinkSync(file.path));
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Zipping failed.");
  }
});

app.post("/api/v2/unzip", upload.single("zipfile"), async (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const extractDir = path.join(UPLOAD_DIR, "unzipped-" + Date.now());
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(req.file.path);

    const files = fs.readdirSync(extractDir).map((f) => ({
      name: f,
      url: `/download/${f}`,
    }));

    res.json({ extracted: files });
  } catch (err) {
    console.error(err);
    res.status(500).send("Unzipping failed.");
  }
});

// ------------------------------
// END: EverToolbox v2 Routes
// ------------------------------



// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`EverToolbox backend listening on port ${PORT}`);
});
