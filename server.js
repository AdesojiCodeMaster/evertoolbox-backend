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
import { fromPath as pdf2picFromPath } from "pdf2pic";
import sanitizeFilename from "sanitize-filename";
import pdfParse from "pdf-parse";
import { Document, Packer, Paragraph, TextRun } from "docx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// simple safe filename sanitizer (no external dependency)
const sanitize = (name = "") => name.replace(/[^a-zA-Z0-9._-]/g, "_");
//çonst safeFilename = sanitize;





const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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


// -----------------------------
const router = express.Router();

// --- Static folders for downloads ---
//app.use(express.static("converted"));
//app.use(express.static("compressed"));
app.use("/converted", express.static(CONVERTED));
app.use("/compressed", express.static(COMPRESSED));


// --- Ensure directories exist 
// Directories
const UPLOADS = path.join(__dirname, "uploads");
const CONVERTED = path.join(__dirname, "converted");
const COMPRESSED = path.join(__dirname, "compressed");
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(CONVERTED, { recursive: true });
fs.mkdirSync(COMPRESSED, { recursive: true });
// --- Helper cleanup function ---
// Helpers
const cleanup = (p) => {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
};

// ========================= FILE CONVERTER + COMPRESSOR =========================



// server.js — EverToolbox full backend (ESM)
// Replace your current server.js with this file.


function makePdfFromText(text, outPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pageWidth = 612, pageHeight = 792;
      const margin = 48;
      const lineHeight = 14;
      const maxCharsPerLine = 90;

      // naive wrap into lines
      const words = text.replace(/\r/g, "").split(/\s+/);
      const lines = [];
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > maxCharsPerLine) { lines.push(cur.trim()); cur = w; }
        else cur = (cur + " " + w).trim();
      }
      if (cur) lines.push(cur);

      let i = 0;
      while (i < lines.length) {
        const page = doc.addPage([pageWidth, pageHeight]);
        let y = pageHeight - margin;
        while (i < lines.length && y > margin) {
          page.drawText(lines[i].slice(0, 1000), { x: margin, y, size: 12, font });
          y -= lineHeight;
          i++;
        }
      }

      const bytes = await doc.save();
      fs.writeFileSync(outPath, bytes);
      resolve();
    } catch (err) { reject(err); }
  });
}

// Create simple DOCX from text using 'docx' package
async function makeDocxFromText(text, outPath) {
  const doc = new Document();
  const paragraphs = text.split(/\n+/).map(p => new Paragraph({ children: [ new TextRun(p) ] }));
  doc.addSection({ children: paragraphs });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

// Create PDF containing a single image (image -> pdf)
async function makePdfFromImage(imagePath, outPath) {
  const imgBuf = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  let embedded;
  // support jpg/jpeg vs png
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    embedded = await pdfDoc.embedJpg(imgBuf);
  } else {
    // convert any non-jpg to PNG buffer via sharp then embed as png
    const pngBuf = await sharp(imgBuf).png().toBuffer();
    embedded = await pdfDoc.embedPng(pngBuf);
  }
  const page = pdfDoc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  const out = await pdfDoc.save();
  fs.writeFileSync(outPath, out);
}

// Utility: build download URL given local path and request
function makeDownloadUrl(req, filePath) {
  const rel = path.relative(__dirname, filePath).replace(/\\/g, "/");
  // If file is under converted or compressed we mapped static route
  if (rel.startsWith("converted/")) return `${req.protocol}://${req.get("host")}/${rel}`;
  if (rel.startsWith("compressed/")) return `${req.protocol}://${req.get("host")}/${rel}`;
  // fallback
  return `${req.protocol}://${req.get("host")}/${rel}`;
}

// =======================================================
// CONVERT route (handles many conversions)
// =======================================================
app.post("/convert", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const outputFormatRaw = (req.body.outputFormat || "").toString().replace(/^\./, "").toLowerCase();
    const watermark = (req.body.watermark || "").toString();
    const rename = (req.body.rename || "").toString();
    const inputPath = req.file.path;
    const originalName = req.file.originalname || "file";
    const inputExt = path.extname(originalName).toLowerCase();
    const baseName = path.basename(originalName, path.extname(originalName));

    // determine final ext and filename
    const finalExt = outputFormatRaw || inputExt.replace(/^\./, "");
    const outFilename = sanitizeFilename((rename && rename.trim()) ? rename : `${baseName}_converted.${finalExt}`);
    const outPath = path.join(CONVERTED, outFilename);

    // ---------- TXT -> PDF or DOCX or TXT(copy) ----------
    if (inputExt === ".txt") {
      const txt = fs.readFileSync(inputPath, "utf8");
      if (finalExt === "pdf") {
        await makePdfFromText(txt, outPath);
      } else if (finalExt === "docx") {
        await makeDocxFromText(txt, outPath);
      } else if (finalExt === "txt") {
        fs.writeFileSync(outPath, txt, "utf8");
      } else {
        cleanup(inputPath);
        return res.status(400).json({ error: `TXT → ${finalExt} not supported` });
      }
    }
    // ---------- DOCX -> PDF / TXT / DOCX(copy) ----------
    else if (inputExt === ".docx") {
      if (finalExt === "txt") {
        const { value: rawText } = await mammoth.extractRawText({ path: inputPath });
        fs.writeFileSync(outPath, rawText || "", "utf8");
      } else if (finalExt === "pdf") {
        const { value: html } = await mammoth.convertToHtml({ path: inputPath });
        const text = html.replace(/<[^>]+>/g, "\n").replace(/\n\s+\n/g, "\n").trim();
        await makePdfFromText(text.substring(0, 20000), outPath);
      } else if (finalExt === "docx") {
        // copy original to converted folder (or save under new name)
        fs.copyFileSync(inputPath, outPath);
      } else if (["jpg","jpeg","png","webp"].includes(finalExt)) {
        // Convert docx -> pdf -> image (first page)
        const tempPdf = path.join(UPLOADS, `${baseName}_tmp.pdf`);
        const { value: html } = await mammoth.convertToHtml({ path: inputPath });
        const text = html.replace(/<[^>]+>/g, "\n").substring(0, 20000);
        await makePdfFromText(text, tempPdf);
        // convert first page to image using pdf2pic
        const converter = pdf2picFromPath(tempPdf, { density: 150, saveFilename: "page", savePath: CONVERTED, format: finalExt, width: 1200 });
        await converter(1);
        const tmpImg = path.join(CONVERTED, `page_1.${finalExt}`);
        fs.renameSync(tmpImg, outPath);
        cleanup(tempPdf);
      } else {
        cleanup(inputPath);
        return res.status(400).json({ error: `DOCX → ${finalExt} not supported` });
      }
    }
    // ---------- IMAGE input ----------
    else if ([".jpg", ".jpeg", ".png", ".webp"].includes(inputExt)) {
      // image -> pdf
      if (finalExt === "pdf") {
        await makePdfFromImage(inputPath, outPath);
      } else if (["jpg","jpeg","png","webp"].includes(finalExt)) {
        // image -> image
        const fmt = finalExt === "jpg" ? "jpeg" : finalExt;
        await sharp(inputPath).toFormat(fmt).toFile(outPath);
      } else if (finalExt === "txt" || finalExt === "docx") {
        // not practical to OCR here; return not supported
        cleanup(inputPath);
        return res.status(400).json({ error: `Image → ${finalExt} is not supported (OCR not available)` });
      } else {
        cleanup(inputPath);
        return res.status(400).json({ error: `Image → ${finalExt} not supported` });
      }
    }
    // ---------- PDF input ----------
    else if (inputExt === ".pdf") {
      // PDF -> TXT (extract text)
      if (finalExt === "txt") {
        const data = fs.readFileSync(inputPath);
        const parsed = await pdfParse(data);
        fs.writeFileSync(outPath, (parsed.text || ""), "utf8");
      }
      // PDF -> Image (first page)
      else if (["jpg","jpeg","png","webp"].includes(finalExt)) {
        const format = finalExt === "jpg" ? "jpg" : finalExt;
        const converter = pdf2picFromPath(inputPath, { density: 150, saveFilename: "page", savePath: CONVERTED, format, width: 1200 });
        await converter(1);
        const tmp = path.join(CONVERTED, `page_1.${format}`);
        fs.renameSync(tmp, outPath);
      }
      // PDF -> PDF (watermark only)
      else if (finalExt === "pdf") {
        if (watermark) {
          const pdfDoc = await PDFDocument.load(fs.readFileSync(inputPath));
          const pages = pdfDoc.getPages();
          const helvetica = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
          pages.forEach((page) => {
            const { width, height } = page.getSize();
            page.drawText(String(watermark), {
              x: width/2 - 100,
              y: height/2,
              size: 36,
              font: helvetica,
              color: rgb(0.7, 0.7, 0.7),
              rotate: { degrees: 45 }
            });
          });
          const outBytes = await pdfDoc.save();
          fs.writeFileSync(outPath, outBytes);
        } else {
          // copy
          fs.copyFileSync(inputPath, outPath);
        }
      } else {
        cleanup(inputPath);
        return res.status(400).json({ error: `PDF → ${finalExt} not supported` });
      }
    } else {
      cleanup(inputPath);
      return res.status(400).json({ error: `Input type ${inputExt} not supported for conversion` });
    }

    // done, remove uploaded input
    cleanup(inputPath);

    // Get file size
    const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    const downloadUrl = makeDownloadUrl(req, outPath);

    return res.json({ message: "Conversion successful", downloadUrl, fileSize });
  } catch (err) {
    console.error("convert error:", err);
    // try cleanup input
    try { if (req.file && req.file.path) cleanup(req.file.path); } catch(e){}
    return res.status(500).json({ error: "Conversion failed", details: err.message || String(err) });
  }
});

// =======================================================
// COMPRESS route (images, pdf, txt, docx) — produces direct file in /compressed
// =======================================================
app.post("/compress", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const q = parseInt(req.body.quality || req.query.quality || "75", 10);
    const quality = Math.max(30, Math.min(95, isNaN(q) ? 75 : q));
    const inputPath = req.file.path;
    const originalName = req.file.originalname || "file";
    const ext = path.extname(originalName).toLowerCase();
    const baseName = path.basename(originalName, ext);

    const outName = sanitizeFilename(`${baseName}_compressed${ext}`);
    const outPath = path.join(COMPRESSED, outName);

    // IMAGES
    if ([".jpg", ".jpeg"].includes(ext)) {
      await sharp(inputPath).jpeg({ quality, mozjpeg: true }).toFile(outPath);
    } else if (ext === ".png") {
      await sharp(inputPath).png({ compressionLevel: 9, quality }).toFile(outPath);
    } else if (ext === ".webp") {
      await sharp(inputPath).webp({ quality }).toFile(outPath);
    }
    // PDF: re-save optimized
    else if (ext === ".pdf") {
      const bytes = fs.readFileSync(inputPath);
      const pdfDoc = await PDFDocument.load(bytes);
      const newPdf = await PDFDocument.create();
      const pages = await newPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
      pages.forEach(p => newPdf.addPage(p));
      const outBytes = await newPdf.save({ useObjectStreams: true });
      fs.writeFileSync(outPath, outBytes);
    }
    // TXT: simple minify (remove extra whitespace)
    else if (ext === ".txt") {
      const txt = fs.readFileSync(inputPath, "utf8");
      // remove repeated whitespace & trim
      const min = txt.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
      fs.writeFileSync(outPath, min, "utf8");
    }
    // DOCX: extract text and create a smaller docx with that text
    else if (ext === ".docx") {
      const { value: rawText } = await mammoth.extractRawText({ path: inputPath });
      // create docx from rawText (this will likely be smaller than original if original had images/metadata)
      await makeDocxFromText((rawText || "").slice(0, 200000), outPath);
    } else {
      cleanup(inputPath);
      return res.status(400).json({ error: "Unsupported file type for compression" });
    }

    const beforeSize = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
    const afterSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    cleanup(inputPath);

    const downloadUrl = makeDownloadUrl(req, outPath);
    return res.json({ message: "Compression successful", originalSize: beforeSize, compressedSize: afterSize, downloadUrl });
  } catch (err) {
    console.error("compress error:", err);
    try { if (req.file && req.file.path) cleanup(req.file.path); } catch(e){}
    return res.status(500).json({ error: "Compression failed", details: err.message || String(err) });
  }
});

// Simple root
app.get("/", (req, res) => res.send("EverToolbox backend (full convert/compress) ✅"));

// Start
//const PORT = process.env.PORT || 4000;
//app.listen(PORT, () => console.log(`EverToolbox backend listening on port ${PORT}`));


      

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
