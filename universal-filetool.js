// universal-filetool.js
// EverToolbox router: single-file uploads, conversion + compression,
// ensures naked outputs (no zips/folders), prevents same-format conversions,
// integrity checks, useful JSON errors.

"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { execSync, exec } = require("child_process");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PDFDocument } = require("pdf-lib");
const mammoth = require("mammoth");
const TurndownService = require("turndown");

const execP = util.promisify(exec); // <--- PROMISIFIED exec (was missing)
const router = express.Router();

// directories
const UPLOADS = path.join(__dirname, "uploads");
const PROCESSED = path.join(__dirname, "processed");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PROCESSED)) fs.mkdirSync(PROCESSED, { recursive: true });

// multer single-file
const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 300 } }).single("file");

// checks for installed binaries
function whichSync(cmd) {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS = {
  ffmpeg: whichSync("ffmpeg"),
  pdftoppm: whichSync("pdftoppm"),
  libreoffice: whichSync("libreoffice") || whichSync("soffice"),
  unoconv: whichSync("unoconv"),
  convert: whichSync("convert"),
  gs: whichSync("gs")
};

// static sets
const IMAGE_OUTPUTS = ['jpeg','jpg','png','webp','tiff','tif','gif','avif','heic','bmp'];
const AUDIO_OUTPUTS = ['mp3','wav','ogg','aac','flac','m4a'];
const VIDEO_OUTPUTS = ['mp4','webm','mov','avi','mkv'];
const DOC_OUTPUTS = ['pdf','doc','docx','odt','rtf','html','txt','md'];

// util helpers
const safeUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e){} };
const safeStat = (p) => { try { return fs.statSync(p); } catch(e){ return null; } };
function extOfFilename(filename) { return path.extname(filename || '').replace('.', '').toLowerCase(); }
function isArchiveOrFolder(name, mimetype) {
  const ext = path.extname(name || '').toLowerCase();
  const archiveExts = ['.zip','.rar','.7z','.tar','.gz','.tgz','.bz2'];
  if (archiveExts.includes(ext)) return true;
  if (mimetype && (mimetype.includes('zip') || mimetype.includes('compressed') || mimetype.includes('tar'))) return true;
  return false;
}
function ensureOutputPath(baseName, ext) {
  if (!ext) return path.join(PROCESSED, baseName);
  const sanitized = ext.startsWith('.') ? ext.slice(1) : ext;
  return path.join(PROCESSED, `${baseName}.${sanitized}`);
}
function checkIntegrity(filePath) {
  try { const s = fs.statSync(filePath); return s && s.size > 0; } catch (e) { return false; }
}
function scheduleDelete(p, ms = 1000 * 60 * 60 * 3) { setTimeout(() => { safeUnlink(p); }, ms); }
function periodicSweep(dir, olderThanMs = 1000 * 60 * 60 * 6) {
  try {
    const items = fs.readdirSync(dir);
    const now = Date.now();
    items.forEach(f => {
      const p = path.join(dir, f);
      const st = safeStat(p);
      if (st && (now - st.mtimeMs) > olderThanMs) safeUnlink(p);
    });
  } catch(e) { console.error("Sweep error:", e); }
}
setInterval(() => { periodicSweep(UPLOADS); periodicSweep(PROCESSED); }, 1000 * 60 * 60);

// send naked file with proper disposition
function sendNakedFile(res, filePath, suggestedName) {
  if (!fs.existsSync(filePath)) return res.status(500).json({ error: "Output file not found." });
  const name = suggestedName || path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/["\\]/g, '')}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath, (err) => {
    if (err) console.error("sendFile error:", err);
    scheduleDelete(filePath, 1000 * 60 * 30);
  });
}

// image conversion fallback (sharp primary, ImageMagick convert fallback)
async function convertImageFallback(inPath, outPath, outExt) {
  const fmt = outExt.toLowerCase();
  if (['jpeg','jpg','png','webp','tiff','tif','gif','avif','heic'].includes(fmt)) {
    const sharpFmt = fmt === 'jpg' ? 'jpeg' : fmt;
    await sharp(inPath).toFormat(sharpFmt).toFile(outPath);
    return;
  }
  if (HAS.convert) {
    // Use execP (promisified exec)
    await execP(`convert "${inPath}" "${outPath}"`);
    return;
  }
  fs.copyFileSync(inPath, outPath);
}

// image compression using sharp (quality map)
async function compressImage(inPath, outPath, intensity='medium') {
  const qMap = { low: 80, medium: 60, high: 45 };
  const q = qMap[intensity] || 60;
  const ext = path.extname(outPath).slice(1).toLowerCase() || 'jpg';
  if (['jpg','jpeg'].includes(ext)) await sharp(inPath).jpeg({ quality: q }).toFile(outPath);
  else if (ext === 'png') await sharp(inPath).png({ compressionLevel: 8 }).toFile(outPath);
  else if (HAS.convert) await execP(`convert "${inPath}" -quality ${q} "${outPath}"`);
  else await sharp(inPath).jpeg({ quality: q }).toFile(outPath);
}

// compress PDF with ghostscript
async function compressPdfGs(inPath, outPath) {
  if (!HAS.gs) throw new Error("ghostscript (gs) required for PDF compression");
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dQUIET -dNOPAUSE -dBATCH -sOutputFile="${outPath}" "${inPath}"`;
  await execP(cmd);
}

// compress media via ffmpeg with conservative settings
function compressMedia(inPath, outPath, outExt, intensity='medium') {
  const vMap = { low: '1500k', medium: '800k', high: '400k' };
  const aMap = { low: '192k', medium: '128k', high: '96k' };
  const vBit = vMap[intensity] || '800k';
  const aBit = aMap[intensity] || '128k';

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inPath);
    if (outExt === 'mp4') cmd.outputOptions(["-c:v libx264", `-b:v ${vBit}`, "-preset veryfast", `-b:a ${aBit}`, "-c:a aac"]);
    else if (outExt === 'webm') cmd.outputOptions([`-b:v ${vBit}`, "-c:v libvpx-vp9", "-c:a libopus"]);
    else if (['mp3','aac','wav','flac','ogg'].includes(outExt)) {
      if (outExt === 'mp3') cmd.audioCodec('libmp3lame').audioBitrate(aBit);
      else if (outExt === 'aac') cmd.audioCodec('aac').audioBitrate(aBit);
      else if (outExt === 'wav') cmd.audioCodec('pcm_s16le');
      else cmd.audioBitrate(aBit);
    } else cmd.outputOptions([`-b:v ${vBit}`, `-b:a ${aBit}`]);

    cmd.toFormat(outExt).save(outPath).on("end", resolve).on("error", reject);
  });
}

// Entry route: single file only
router.post("/", (req, res) => {
  upload(req, res, async function (err) {
    if (err) { console.error("Upload error:", err); return res.status(400).json({ error: "Upload error", details: String(err) }); }
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Upload a single file." });

    const file = req.file;
    const originalName = file.originalname || 'upload';
    const inputPath = file.path;
    const mimetype = file.mimetype || '';
    const inputExt = extOfFilename(originalName) || (mimetype.split('/')[1] || '');
    if (isArchiveOrFolder(originalName, mimetype)) { safeUnlink(inputPath); return res.status(400).json({ error: "Archives/folders not supported. Upload a single file." }); }

    const mode = (req.body.mode || 'convert').toLowerCase();
    const target = (req.body.targetFormat || '').toLowerCase();
    const intensity = (req.body.qualityLevel || 'medium').toLowerCase();
    const baseName = `result_${Date.now()}`;
    try {
      // Prevent same-format conversions
      if (mode === 'convert' && target && inputExt && target.toLowerCase() === inputExt.toLowerCase()) {
        safeUnlink(inputPath);
        return res.status(400).json({ error: "You selected the same format as the original file — conversion cancelled." });
      }

      // output path
      const outputExt = target || inputExt || '';
      const outputPath = ensureOutputPath(baseName, outputExt);

      // COMPRESS
      if (mode === 'compress') {
        if (mimetype.startsWith("image/")) {
          const outExt = inputExt || 'jpg';
          const outPath = ensureOutputPath(baseName, outExt);
          await compressImage(inputPath, outPath, intensity);

          const origSt = safeStat(inputPath), outSt = safeStat(outPath);
          if (!outSt || outSt.size === 0) { safeUnlink(inputPath); safeUnlink(outPath); return res.status(500).json({ error: "Compression failed (image)." }); }
          if (outSt.size >= origSt.size) {
            const originalCopy = ensureOutputPath(`${baseName}_orig`, inputExt);
            fs.copyFileSync(inputPath, originalCopy);
            safeUnlink(inputPath); safeUnlink(outPath);
            scheduleDelete(originalCopy);
            return sendNakedFile(res, originalCopy, originalName);
          }
          safeUnlink(inputPath);
          scheduleDelete(outPath);
          return sendNakedFile(res, outPath, `${path.basename(originalName, path.extname(originalName))}.${outExt}`);
        }

        if (mimetype.startsWith("video/") || mimetype.startsWith("audio/")) {
          if (!HAS.ffmpeg) { safeUnlink(inputPath); return res.status(501).json({ error: "ffmpeg is required for media compression." }); }
          const outExt = outputExt || (mimetype.startsWith("video/") ? 'mp4' : 'mp3');
          const outPath = ensureOutputPath(baseName, outExt);
          await compressMedia(inputPath, outPath, outExt, intensity).catch(e => { throw e; });

          const origSt = safeStat(inputPath), outSt = safeStat(outPath);
          if (!outSt || outSt.size === 0) { safeUnlink(inputPath); safeUnlink(outPath); return res.status(500).json({ error: "Compression failed (media)." }); }
          if (outSt.size >= origSt.size) {
            const originalCopy = ensureOutputPath(`${baseName}_orig`, inputExt);
            fs.copyFileSync(inputPath, originalCopy);
            safeUnlink(inputPath); safeUnlink(outPath);
            scheduleDelete(originalCopy);
            return sendNakedFile(res, originalCopy, originalName);
          }
          safeUnlink(inputPath);
          scheduleDelete(outPath);
          return sendNakedFile(res, outPath, `${path.basename(originalName, path.extname(originalName))}.${outExt}`);
        }

        if (inputExt === 'pdf') {
          if (!HAS.gs) { safeUnlink(inputPath); return res.status(501).json({ error: "ghostscript (gs) required for PDF compression." }); }
          const outPath = ensureOutputPath(baseName, 'pdf');
          await compressPdfGs(inputPath, outPath).catch(e => { throw e; });
          const origSt = safeStat(inputPath), outSt = safeStat(outPath);
          if (!outSt || outSt.size === 0) { safeUnlink(inputPath); safeUnlink(outPath); return res.status(500).json({ error: "PDF compression failed." }); }
          if (outSt.size >= origSt.size) {
            const originalCopy = ensureOutputPath(`${baseName}_orig`, 'pdf');
            fs.copyFileSync(inputPath, originalCopy);
            safeUnlink(inputPath); safeUnlink(outPath);
            scheduleDelete(originalCopy);
            return sendNakedFile(res, originalCopy, originalName);
          }
          safeUnlink(inputPath);
          scheduleDelete(outPath);
          return sendNakedFile(res, outPath, `${path.basename(originalName, path.extname(originalName))}.pdf`);
        }

        safeUnlink(inputPath);
        return res.status(400).json({ error: "Compression not supported for this file type." });
      } // end compress

      // CONVERT
      if (mode === 'convert') {
        // image conversions (including image->pdf)
        if (mimetype.startsWith("image/") && (IMAGE_OUTPUTS.includes(outputExt) || outputExt === 'pdf')) {
          if (outputExt === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            const imageBuf = fs.readFileSync(inputPath);
            let img;
            if (['png'].includes(inputExt)) img = await pdfDoc.embedPng(imageBuf);
            else img = await pdfDoc.embedJpg(imageBuf);
            const page = pdfDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            fs.writeFileSync(outputPath, await pdfDoc.save());
            if (!checkIntegrity(outputPath)) { safeUnlink(inputPath); safeUnlink(outputPath); return res.status(500).json({ error: "Image→PDF failed." }); }
            safeUnlink(inputPath);
            scheduleDelete(outputPath);
            return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.pdf`);
          } else {
            const outPath = ensureOutputPath(baseName, outputExt);
            await convertImageFallback(inputPath, outPath, outputExt);
            if (!checkIntegrity(outPath)) { safeUnlink(inputPath); safeUnlink(outPath); return res.status(500).json({ error: "Image conversion failed." }); }
            safeUnlink(inputPath);
            scheduleDelete(outPath);
            return sendNakedFile(res, outPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
          }
        }

        // pdf to image
        if (inputExt === 'pdf' && IMAGE_OUTPUTS.includes(outputExt)) {
          if (!HAS.pdftoppm) { safeUnlink(inputPath); return res.status(501).json({ error: "pdftoppm (poppler-utils) required for PDF→Image." }); }
          const base = path.join(PROCESSED, baseName);
          const flag = (outputExt === 'jpg' || outputExt === 'jpeg') ? 'jpeg' : outputExt;
          const cmd = `pdftoppm -${flag} -singlefile "${inputPath}" "${base}"`;
          await execP(cmd);
          const produced = `${base}.${flag}`;
          if (!fs.existsSync(produced) || !checkIntegrity(produced)) { safeUnlink(inputPath); return res.status(500).json({ error: "PDF→Image failed." }); }
          safeUnlink(inputPath);
          scheduleDelete(produced);
          return sendNakedFile(res, produced, `${path.basename(originalName, '.pdf')}.${outputExt}`);
        }

        // doc/docx -> md/html/txt/pdf
        if (['doc','docx','odt'].includes(inputExt)) {
          if (outputExt === 'md') {
            const buffer = fs.readFileSync(inputPath);
            const { value: html } = await mammoth.convertToHtml({ buffer });
            const t = new TurndownService();
            const md = t.turndown(html);
            fs.writeFileSync(outputPath, md, 'utf8');
            if (!checkIntegrity(outputPath)) { safeUnlink(inputPath); safeUnlink(outputPath); return res.status(500).json({ error: "DOCX→MD failed." }); }
            safeUnlink(inputPath);
            scheduleDelete(outputPath);
            return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.md`);
          }
          if (HAS.unoconv || HAS.libreoffice) {
            const expectedOut = ensureOutputPath(path.basename(inputPath, path.extname(inputPath)), outputExt || 'pdf');
            try {
              if (HAS.unoconv) await execP(`unoconv -f ${outputExt} -o "${expectedOut}" "${inputPath}"`);
              else await execP(`libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir "${PROCESSED}"`);
            } catch (e) {
              safeUnlink(inputPath);
              return res.status(500).json({ error: "LibreOffice/unoconv conversion failed.", details: String(e) });
            }
            if (!fs.existsSync(expectedOut) || !checkIntegrity(expectedOut)) { safeUnlink(inputPath); return res.status(500).json({ error: "Document conversion failed." }); }
            safeUnlink(inputPath);
            scheduleDelete(expectedOut);
            return sendNakedFile(res, expectedOut, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
          } else {
            const buffer = fs.readFileSync(inputPath);
            const { value: html } = await mammoth.convertToHtml({ buffer });
            if (outputExt === 'html') {
              fs.writeFileSync(outputPath, html);
              if (!checkIntegrity(outputPath)) { safeUnlink(inputPath); safeUnlink(outputPath); return res.status(500).json({ error: "DOCX→HTML failed." }); }
              safeUnlink(inputPath);
              scheduleDelete(outputPath);
              return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
            } else if (outputExt === 'txt') {
              const txt = html.replace(/<[^>]+>/g, "");
              fs.writeFileSync(outputPath, txt);
              if (!checkIntegrity(outputPath)) { safeUnlink(inputPath); safeUnlink(outputPath); return res.status(500).json({ error: "DOCX→TXT failed." }); }
              safeUnlink(inputPath);
              scheduleDelete(outputPath);
              return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.txt`);
            } else {
              safeUnlink(inputPath);
              return res.status(400).json({ error: "Requested document output format not supported by available tools." });
            }
          }
        }

        // text/html/md conversions and to PDF
        if (['txt','md','html'].includes(inputExt)) {
          const content = fs.readFileSync(inputPath, 'utf8');
          if (['txt','md','html'].includes(outputExt)) {
            if (inputExt === 'md' && outputExt === 'html') {
              const outHtml = `<pre>${content}</pre>`;
              fs.writeFileSync(outputPath, outHtml);
              if (!checkIntegrity(outputPath)) { safeUnlink(inputPath); safeUnlink(outputPath); return res.status(500).json({ error: "MD→HTML failed." }); }
              safeUnlink(inputPath);
              scheduleDelete(outputPath);
              return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
            }
            fs.writeFileSync(outputPath, content);
            safeUnlink(inputPath);
            scheduleDelete(outputPath);
            return sendNakedFile(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
          }
          if (outputExt === 'pdf') {
            if (HAS.unoconv || HAS.libreoffice) {
              const tmpHtml = ensureOutputPath(`${baseName}_tmp`, 'html');
              fs.writeFileSync(tmpHtml, inputExt === 'html' ? content : `<pre>${content}</pre>`);
              const outPdf = ensureOutputPath(baseName, 'pdf');
              if (HAS.unoconv) await execP(`unoconv -f pdf -o "${outPdf}" "${tmpHtml}"`);
              else await execP(`libreoffice --headless --convert-to pdf "${tmpHtml}" --outdir "${PROCESSED}"`);
              safeUnlink(tmpHtml); safeUnlink(inputPath);
              if (!checkIntegrity(outPdf)) { safeUnlink(outPdf); return res.status(500).json({ error: "TXT/HTML→PDF failed." }); }
              scheduleDelete(outPdf);
              return sendNakedFile(res, outPdf, `${path.basename(originalName, path.extname(originalName))}.pdf`);
            } else {
              safeUnlink(inputPath);
              return res.status(501).json({ error: "libreoffice/unoconv required for TXT→PDF." });
            }
          }
        }

        // audio/video conversions
        if ((mimetype.startsWith("audio/") || mimetype.startsWith("video/")) && (AUDIO_OUTPUTS.includes(outputExt) || VIDEO_OUTPUTS.includes(outputExt))) {
          if (!HAS.ffmpeg) { safeUnlink(inputPath); return res.status(501).json({ error: "ffmpeg required for media conversion." }); }
          const outExt = outputExt || (mimetype.startsWith("video/") ? 'mp4' : 'mp3');
          const outPath = ensureOutputPath(baseName, outExt);
          await new Promise((resolve, reject) => {
            const proc = ffmpeg(inputPath);
            if (outExt === 'webm') proc.outputOptions(["-c:v libvpx-vp9 -b:v 1M -c:a libopus"]);
            else if (outExt === 'mp4') proc.outputOptions(["-c:v libx264 -preset fast -c:a aac"]);
            else if (outExt === 'mp3') proc.outputOptions(["-c:a libmp3lame -b:a 128k"]);
            proc.toFormat(outExt).save(outPath).on("end", resolve).on("error", reject);
          }).catch(e => { throw e; });

          if (!checkIntegrity(outPath)) { safeUnlink(inputPath); safeUnlink(outPath); return res.status(500).json({ error: "Media conversion failed (ffmpeg)." }); }
          safeUnlink(inputPath);
          scheduleDelete(outPath);
          return sendNakedFile(res, outPath, `${path.basename(originalName, path.extname(originalName))}.${outExt}`);
        }

        // fallback: copy original as naked file (ensure extension)
        const fallbackOut = ensureOutputPath(baseName, outputExt || inputExt);
        fs.copyFileSync(inputPath, fallbackOut);
        safeUnlink(inputPath);
        scheduleDelete(fallbackOut);
        return sendNakedFile(res, fallbackOut, `${path.basename(originalName, path.extname(originalName))}.${outputExt || inputExt}`);
      } // end convert

      safeUnlink(inputPath);
      return res.status(400).json({ error: "Unknown mode. Use 'convert' or 'compress'." });
    } catch (err) {
      console.error("Conversion error:", err && err.stack ? err.stack : err);
      try { safeUnlink(inputPath); } catch(e) {}
      return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
    }
  });
});

module.exports = router;
  
