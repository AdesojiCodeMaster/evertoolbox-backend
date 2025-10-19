// universal-filetool.js
// Updated version — copy / paste to replace existing file.
// Key changes:
// - Single-file enforcement
// - Better logging & error details
// - Prevent same-format conversions
// - Ensure correct output extension
// - Improved image/audio/video compression
// - Document compression (PDF via ghostscript, Office files via zip recompress + media image shrink)
// - Safe cleanup and size logging

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { exec, execSync } = require("child_process");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PDFDocument } = require("pdf-lib");
const mammoth = require("mammoth");
const archiver = require("archiver");
const AdmZip = require("adm-zip"); // add to package.json
const utilprom = util;
const execP = util.promisify(require("child_process").exec);
const router = express.Router();

const UPLOADS = path.join(__dirname, "uploads");
const PROCESSED = path.join(__dirname, "processed");

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PROCESSED)) fs.mkdirSync(PROCESSED, { recursive: true });

// Multer - single file only
const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB max, adjust as needed

// Helpers
const safeUnlink = (p) => {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { console.error("safeUnlink err", e && e.message); }
};
const safeStat = (p) => {
  try { return fs.statSync(p); } catch (e) { return null; }
};
function ensureExtension(name, ext) {
  if (!ext) return name;
  ext = ext.replace(/^\./, "").toLowerCase();
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}
function nowLog(...args) { console.log(new Date().toISOString(), ...args); }
function whichSync(cmd) {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS = {
  ffmpeg: whichSync("ffmpeg"),
  pdftoppm: whichSync("pdftoppm"),
  libreoffice: whichSync("libreoffice") || whichSync("soffice"),
  unoconv: whichSync("unoconv"),
  convert: whichSync("convert"),
  gs: whichSync("gs"),
  zip: whichSync("zip")
};

function missingToolsResponse(res, tools) {
  return res.status(501).json({
    error: "Required system tools are missing for this operation.",
    missing: tools,
    help: "Make sure binaries are installed in the container (ffmpeg, pdftoppm/poppler-utils, libreoffice/unoconv, ghostscript)."
  });
}

// schedule deletion of a file after N milliseconds
function scheduleDelete(filePath, ms = 1000 * 60 * 30) { // default 30 min
  setTimeout(() => { safeUnlink(filePath); }, ms);
}

// periodic sweep to delete old files older than threshold (ms)
function periodicSweep(dir, olderThanMs = 1000 * 60 * 60 * 6) {
  try {
    const files = fs.readdirSync(dir);
    const now = Date.now();
    files.forEach(f => {
      const p = path.join(dir, f);
      const st = safeStat(p);
      if (st && (now - st.mtimeMs) > olderThanMs) {
        safeUnlink(p);
      }
    });
  } catch (e) { console.error("Sweep error:", e && e.message); }
}
setInterval(() => { periodicSweep(UPLOADS); periodicSweep(PROCESSED); }, 1000 * 60 * 60);

// helper to send a file and cleanup
function sendAndCleanup(res, filePath, downloadName) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found." });
  }
  const name = downloadName || path.basename(filePath);
  res.download(filePath, name, (err) => {
    if (err) console.error("Download error:", err && err.message);
    scheduleDelete(filePath, 1000 * 60 * 30);
  });
}

// small utility to shrink image files in a folder (used for Office zip internals)
async function shrinkInternalImage(filePath, quality = 70) {
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!["jpg","jpeg","png","webp","tiff"].includes(ext)) return;
    const tmpOut = `${filePath}.shrunk`;
    if (ext === "png") {
      await sharp(filePath).png({ quality }).toFile(tmpOut);
    } else {
      await sharp(filePath).jpeg({ quality }).toFile(tmpOut);
    }
    fs.renameSync(tmpOut, filePath);
  } catch (e) {
    console.warn("shrinkInternalImage failed for", filePath, e && e.message);
  }
}

// MAIN ROUTE
router.post("/", upload.single("file"), async (req, res) => {
  nowLog("[req] incoming", { ip: req.ip, body: req.body });
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    // enforce single file upload (multer.single already does that)
    // but double-check client didn't attempt multiple
    if (req.files && Array.isArray(req.files) && req.files.length > 1) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: "Only one file can be uploaded at a time." });
    }

    const mode = (req.body.mode || "convert").toLowerCase(); // matches your frontend
    const targetFormat = (req.body.targetFormat || "").toLowerCase();
    const originalName = req.file.originalname;
    const inputPath = req.file.path;
    const inputExt = path.extname(originalName).slice(1).toLowerCase();
    const nowBase = `result_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const outputExt = targetFormat || inputExt;
    const outputPath = path.join(PROCESSED, `${nowBase}.${outputExt}`);

    nowLog(`[process] ${mode} request for ${originalName} → ${outputExt}`);

    // Block convert when same format requested (prevent no-op)
    if (mode === "convert" && targetFormat && targetFormat === inputExt) {
      safeUnlink(inputPath);
      return res.status(400).json({
        error: `Source and target formats are the same (${targetFormat}). Please choose a different format to convert.`
      });
    }

    // ---- COMPRESS MODE ----
    if (mode === "compress") {
      nowLog(`[compress] started: ${originalName}`);
      const origStat = safeStat(inputPath);
      const origSize = origStat ? origStat.size : 0;

      // Document compression (PDF)
      if (inputExt === "pdf") {
        if (!HAS.gs) return missingToolsResponse(res, ["ghostscript (gs)"]);
        // -dPDFSETTINGS: /screen (72dpi), /ebook (150dpi), /printer (300dpi)
        const gsOut = outputPath;
        const gsCmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${gsOut}" "${inputPath}"`;
        await execP(gsCmd);
        const afterStat = safeStat(gsOut);
        safeUnlink(inputPath);
        scheduleDelete(gsOut);
        nowLog("[compress] pdf compressed", { before: origSize, after: afterStat ? afterStat.size : null });
        return sendAndCleanup(res, gsOut, ensureExtension(`compressed_${path.basename(originalName)}`, "pdf"));
      }

      // Office files: DOCX / PPTX / XLSX (zip containers) - recompress internals and shrink images
      if (["docx","pptx","xlsx","odt","ods"].includes(inputExt)) {
        try {
          const tmpDir = path.join(PROCESSED, `${nowBase}_unz`);
          fs.mkdirSync(tmpDir);
          const zip = new AdmZip(inputPath);
          zip.extractAllTo(tmpDir, true);

          // find media folder and shrink images
          const mediaFolders = ["word/media", "ppt/media", "xl/media", "Pictures", "Pictures", "media"];
          for (const mf of mediaFolders) {
            const mfPath = path.join(tmpDir, mf);
            if (fs.existsSync(mfPath) && fs.statSync(mfPath).isDirectory()) {
              const imgs = fs.readdirSync(mfPath);
              for (const im of imgs) {
                const ip = path.join(mfPath, im);
                await shrinkInternalImage(ip, 70);
              }
            }
          }

          // Recreate zip with maximum compression
          const rebuilt = new AdmZip();
          const addFilesRec = (dir, base) => {
            const items = fs.readdirSync(dir);
            for (const it of items) {
              const full = path.join(dir, it);
              const rel = path.join(base, it);
              if (fs.statSync(full).isDirectory()) addFilesRec(full, rel);
              else rebuilt.addFile(rel, fs.readFileSync(full));
            }
          };
          addFilesRec(tmpDir, "");
          rebuilt.writeZip(outputPath);

          // cleanup
          const outStat = safeStat(outputPath);
          safeUnlink(inputPath);
          // remove extracted dir (sync)
          const rimraf = (p) => { if (fs.existsSync(p)) { fs.readdirSync(p).forEach(f => { const fp = path.join(p,f); if (fs.statSync(fp).isDirectory()) rimraf(fp); else safeUnlink(fp); }); try { fs.rmdirSync(p); } catch(e){} } };
          rimraf(tmpDir);

          scheduleDelete(outputPath);
          nowLog("[compress] office compressed", { before: origSize, after: outStat ? outStat.size : null });
          return sendAndCleanup(res, outputPath, ensureExtension(`compressed_${path.basename(originalName)}`, inputExt));
        } catch (err) {
          console.error("Office compression failed:", err && err.message);
          safeUnlink(inputPath);
          return res.status(500).json({ error: "Compression failed on server.", details: String(err.message || err) });
        }
      }

      // Image compression via sharp
      if (req.file.mimetype.startsWith("image/")) {
        try {
          const quality = Math.max(30, Math.min(85, parseInt(req.body.quality || "70")));
          // map bmp -> png (sharp doesn't output bmp)
          let outExt = outputExt === "bmp" ? "png" : outputExt;
          outExt = outExt === "jpg" ? "jpeg" : outExt;
          const fmt = outExt || inputExt;
          const tmpOut = path.join(PROCESSED, `${nowBase}.${fmt}`);
          await sharp(inputPath).toFormat(fmt, (fmt === "jpeg" ? { quality } : undefined)).withMetadata(false).toFile(tmpOut);
          const after = safeStat(tmpOut);
          safeUnlink(inputPath);
          scheduleDelete(tmpOut);
          nowLog("[compress] image", { before: origSize, after: after ? after.size : null });
          return sendAndCleanup(res, tmpOut, ensureExtension(`compressed_${path.basename(originalName)}`, fmt));
        } catch (err) {
          console.error("Image compress failed:", err && err.message);
          safeUnlink(inputPath);
          return res.status(500).json({ error: "Compression failed on server.", details: String(err.message || err) });
        }
      }

      // Audio/Video compression via ffmpeg
      if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
        try {
          const isVideo = req.file.mimetype.startsWith("video/");
          const outFormat = outputExt || inputExt;
          const tmpOut = path.join(PROCESSED, `${nowBase}.${outFormat}`);
          await new Promise((resolve, reject) => {
            const proc = ffmpeg(inputPath);
            if (isVideo) {
              proc.outputOptions([
                "-vf", "scale='min(1280,iw)':-2",
                "-b:v", "1000k",
                "-preset", "veryfast",
                "-b:a", "128k"
              ]);
            } else {
              proc.outputOptions(["-b:a", "96k", "-ar", "44100", "-ac", "2"]);
            }
            proc.toFormat(outFormat).save(tmpOut).on("end", resolve).on("error", (e) => reject(e));
          });
          const after = safeStat(path.join(PROCESSED, `${nowBase}.${outputExt}`));
          safeUnlink(inputPath);
          scheduleDelete(path.join(PROCESSED, `${nowBase}.${outputExt}`));
          nowLog("[compress] av", { before: origSize, after: after ? after.size : null });
          return sendAndCleanup(res, path.join(PROCESSED, `${nowBase}.${outputExt}`), ensureExtension(`compressed_${path.basename(originalName)}`, outputExt));
        } catch (err) {
          console.error("AV compress failed:", err && (err.message || err));
          safeUnlink(inputPath);
          return res.status(500).json({ error: "Compression failed on server.", details: String(err.message || err) });
        }
      }

      // Generic: if none matched, reject
      safeUnlink(inputPath);
      return res.status(400).json({ error: "Compression not supported for this file type." });
    } // end compress

    // ---- CONVERT MODE ----
    // IMAGE -> IMAGE or IMAGE -> PDF
    if (req.file.mimetype.startsWith("image/") && ["jpg","jpeg","png","webp","tiff","bmp","gif","pdf"].includes(outputExt)) {
      try {
        if (outputExt === "pdf") {
          const pdfDoc = await PDFDocument.create();
          const imageBuf = fs.readFileSync(inputPath);
          let img;
          if (["png"].includes(inputExt)) img = await pdfDoc.embedPng(imageBuf);
          else img = await pdfDoc.embedJpg(imageBuf);
          const page = pdfDoc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          const pdfBytes = await pdfDoc.save();
          fs.writeFileSync(outputPath, pdfBytes);
          safeUnlink(inputPath);
          scheduleDelete(outputPath);
          return sendAndCleanup(res, outputPath, ensureExtension(`${path.basename(originalName, path.extname(originalName))}.pdf`, "pdf"));
        } else {
          // map bmp output -> png (sharp doesn't support bmp output reliably), but preserve jpg->jpeg mapping
          let fmt = outputExt === "bmp" ? "png" : outputExt;
          fmt = fmt === "jpg" ? "jpeg" : fmt;
          await sharp(inputPath).toFormat(fmt).toFile(outputPath);
          safeUnlink(inputPath);
          scheduleDelete(outputPath);
          return sendAndCleanup(res, outputPath, ensureExtension(`${path.basename(originalName, path.extname(originalName))}.${outputExt}`, outputExt));
        }
      } catch (err) {
        console.error("Conversion error (image):", err && err.stack ? err.stack : err);
        safeUnlink(inputPath);
        return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
      }
    }

    // PDF -> IMAGE via pdftoppm
    if (inputExt === "pdf" && ["jpg","jpeg","png","webp","tiff","bmp"].includes(outputExt)) {
      if (!HAS.pdftoppm) return missingToolsResponse(res, ["pdftoppm (poppler-utils)"]);
      try {
        const base = path.join(PROCESSED, nowBase);
        const flag = outputExt === "jpg" ? "jpeg" : outputExt === "bmp" ? "png" : outputExt;
        const cmd = `pdftoppm -${flag} -singlefile "${inputPath}" "${base}"`;
        await execP(cmd);
        // produced file
        const produced = `${base}.${flag}`;
        if (!fs.existsSync(produced)) throw new Error("pdftoppm did not produce output.");
        safeUnlink(inputPath);
        scheduleDelete(produced);
        return sendAndCleanup(res, produced, ensureExtension(`${path.basename(originalName, ".pdf")}.${outputExt}`, outputExt));
      } catch (err) {
        console.error("Conversion error (pdf->image):", err && err.stack ? err.stack : err);
        safeUnlink(inputPath);
        return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
      }
    }

    // DOCX/ODT -> PDF/HTML/TXT via unoconv/libreoffice when available
    if (["doc","docx","odt","ppt","pptx","xls","xlsx"].includes(inputExt)) {
      if (HAS.unoconv || HAS.libreoffice) {
        try {
          // prefer unoconv for specific formats
          const expectedOut = path.join(PROCESSED, `${path.basename(inputPath, path.extname(inputPath))}.${outputExt}`);
          if (HAS.unoconv) {
            const cmd = `unoconv -f ${outputExt} -o "${expectedOut}" "${inputPath}"`;
            await execP(cmd);
          } else {
            const cmd = `libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir "${PROCESSED}"`;
            await execP(cmd);
          }
          const produced = fs.existsSync(expectedOut) ? expectedOut : path.join(PROCESSED, `${path.basename(inputPath, path.extname(inputPath))}.${outputExt}`);
          if (!fs.existsSync(produced)) throw new Error("LibreOffice/unoconv did not produce output.");
          safeUnlink(inputPath);
          scheduleDelete(produced);
          return sendAndCleanup(res, produced, ensureExtension(`${path.basename(originalName, path.extname(originalName))}.${outputExt}`, outputExt));
        } catch (err) {
          console.error("Conversion error (office):", err && err.stack ? err.stack : err);
          // fallback: mammoth for docx -> html/txt
          if (inputExt === "docx") {
            try {
              const buffer = fs.readFileSync(inputPath);
              const { value: html } = await mammoth.convertToHtml({ buffer });
              if (outputExt === "html") {
                fs.writeFileSync(outputPath, html);
                safeUnlink(inputPath);
                scheduleDelete(outputPath);
                return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
              } else if (outputExt === "txt") {
                const txt = html.replace(/<[^>]+>/g, "");
                fs.writeFileSync(outputPath, txt);
                safeUnlink(inputPath);
                scheduleDelete(outputPath);
                return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.txt`);
              }
            } catch (merr) { console.error("mammoth fallback failed:", merr && merr.message); }
          }
          safeUnlink(inputPath);
          return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
        }
      } else {
        // no libreoffice/unoconv — fallback limited
        safeUnlink(inputPath);
        return missingToolsResponse(res, ["libreoffice/unoconv (required for Office conversions)"]);
      }
    }

    // TXT/MD/HTML conversions
    if (["txt","md","html"].includes(inputExt)) {
      try {
        const content = fs.readFileSync(inputPath, "utf8");
        if (["txt","md","html"].includes(outputExt)) {
          if (inputExt === "md" && outputExt === "html") {
            const outHtml = `<pre>${content}</pre>`;
            fs.writeFileSync(outputPath, outHtml);
            safeUnlink(inputPath);
            scheduleDelete(outputPath);
            return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
          }
          fs.writeFileSync(outputPath, content);
          safeUnlink(inputPath);
          scheduleDelete(outputPath);
          return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
        }
        if (outputExt === "pdf") {
          if (HAS.unoconv || HAS.libreoffice) {
            const tmpHtml = path.join(PROCESSED, `${nowBase}.html`);
            fs.writeFileSync(tmpHtml, inputExt === "html" ? content : `<pre>${content}</pre>`);
            const outPdf = path.join(PROCESSED, `${nowBase}.pdf`);
            if (HAS.unoconv) {
              await execP(`unoconv -f pdf -o "${outPdf}" "${tmpHtml}"`);
            } else {
              await execP(`libreoffice --headless --convert-to pdf "${tmpHtml}" --outdir "${PROCESSED}"`);
            }
            safeUnlink(tmpHtml);
            safeUnlink(inputPath);
            scheduleDelete(outPdf);
            return sendAndCleanup(res, outPdf, `${path.basename(originalName, path.extname(originalName))}.pdf`);
          } else {
            safeUnlink(inputPath);
            return missingToolsResponse(res, ["libreoffice/unoconv (required for TXT/HTML→PDF)"]);
          }
        }
      } catch (err) {
        console.error("Conversion error (txt/md/html):", err && err.stack ? err.stack : err);
        safeUnlink(inputPath);
        return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
      }
    }

    // AUDIO/VIDEO conversions
    if ((req.file.mimetype.startsWith("audio/") || req.file.mimetype.startsWith("video/")) && ["mp4","mp3","wav","ogg","webm","mkv","mov","avi","aac","flac"].includes(outputExt)) {
      if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
      try {
        await new Promise((resolve, reject) => {
          const proc = ffmpeg(inputPath);
          // pick sane codec settings
          if (outputExt === "webm") proc.outputOptions(["-c:v libvpx-vp9 -b:v 1M -c:a libopus"]);
          else if (outputExt === "mp4") proc.outputOptions(["-c:v libx264 -preset fast -c:a aac"]);
          else if (outputExt === "mp3") proc.outputOptions(["-b:a 192k"]);
          else if (outputExt === "aac") proc.outputOptions(["-c:a aac -b:a 128k"]);
          proc.toFormat(outputExt).save(outputPath).on("end", resolve).on("error", reject);
        });
        const outStat = safeStat(outputPath);
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, ensureExtension(`${path.basename(originalName, path.extname(originalName))}.${outputExt}`, outputExt));
      } catch (err) {
        console.error("Conversion error (av):", err && (err.message || err));
        safeUnlink(inputPath);
        return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
      }
    }

    // Generic fallback: copy and return single file (no folder wrapping)
    try {
      fs.copyFileSync(inputPath, outputPath);
      safeUnlink(inputPath);
      scheduleDelete(outputPath);
      return sendAndCleanup(res, outputPath, ensureExtension(`${path.basename(originalName, path.extname(originalName))}.${outputExt}`, outputExt));
    } catch (err) {
      console.error("Generic fallback failed:", err && err.message);
      safeUnlink(inputPath);
      return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
    }

  } catch (err) {
    console.error("Conversion error:", { name: err.name, message: err.message, stack: err.stack });
    return res.status(500).json({ error: "Conversion failed on server.", details: String(err.message || err) });
  }
});

module.exports = router;
