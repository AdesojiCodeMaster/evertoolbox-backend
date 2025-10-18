// universal-filetool.js
// Exports an Express router mounted at /api/tools/file
// Handles convert + compress modes with robust checks for system binaries.
// Auto-cleans uploads/processed files after a few hours and via periodic sweep.

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

const execP = util.promisify(exec);
const router = express.Router();

// storage directories (in repo root)
const UPLOADS = path.join(__dirname, "uploads");
const PROCESSED = path.join(__dirname, "processed");

// ensure dirs
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PROCESSED)) fs.mkdirSync(PROCESSED, { recursive: true });

// Multer
const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 300 } }); // 300MB max

// Helper cleanup and utils
const safeUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e){} };
const safeStat = (p) => { try { return fs.statSync(p); } catch(e){ return null; } };

function whichSync(cmd) {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}

const HAS = {
  ffmpeg: whichSync("ffmpeg"),
  pdftoppm: whichSync("pdftoppm"),
  libreoffice: whichSync("libreoffice") || whichSync("soffice"),
  unoconv: whichSync("unoconv"),
  convert: whichSync("convert") // ImageMagick
};

// Provide missing-tools JSON
function missingToolsResponse(res, tools) {
  return res.status(501).json({
    error: "Required system tools are missing for this conversion.",
    missing: tools,
    help: "Install binaries (ffmpeg, pdftoppm/poppler-utils, libreoffice/unoconv, ImageMagick convert) or deploy the included Dockerfile which installs them."
  });
}

// schedule deletion of a file after N milliseconds
function scheduleDelete(filePath, ms = 1000 * 60 * 60 * 3) { // default 3 hours
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
  } catch (e) {
    console.error("Sweep error:", e);
  }
}
// run sweep every hour
setInterval(() => {
  periodicSweep(UPLOADS);
  periodicSweep(PROCESSED);
}, 1000 * 60 * 60);

// helper to send a file and cleanup
function sendAndCleanup(res, filePath, downloadName) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found." });
  }
  // set headers for download
  const name = downloadName || path.basename(filePath);
  res.download(filePath, name, (err) => {
    if (err) console.error("Download error:", err);
    // schedule deletion just in case
    scheduleDelete(filePath, 1000 * 60 * 30); // 30 min
  });
}

// Main route: upload single file in field 'file'
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const mode = (req.body.mode || "convert").toLowerCase();
  const targetFormat = (req.body.targetFormat || "").toLowerCase();
  const originalName = req.file.originalname;
  const inputPath = req.file.path;
  const inputExt = path.extname(originalName).slice(1).toLowerCase();
  const nowBase = `result_${Date.now()}`;
  const outputExt = targetFormat || inputExt;
  const outputPath = path.join(PROCESSED, `${nowBase}.${outputExt}`);

  try {
    // ===== COMPRESS MODE =====
    if (mode === "compress") {
      // Image compression via sharp
      if (req.file.mimetype.startsWith("image/")) {
        const quality = Math.max(30, Math.min(90, parseInt(req.body.quality || "75")));
        // preserve requested output extension or same input
        const outExt = (outputExt || inputExt) === "jpg" ? "jpeg" : (outputExt || inputExt);
        await sharp(inputPath).toFormat(outExt === "jpeg" ? "jpeg" : outExt).jpeg({ quality }).toFile(outputPath);
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, `compressed_${originalName}`);
      }

      // Audio/video compression needs ffmpeg
      if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
        await new Promise((resolve, reject) => {
          const proc = ffmpeg(inputPath)
            .outputOptions(["-b:v 800k", "-b:a 128k"])
            .toFormat(outputExt || inputExt)
            .save(outputPath)
            .on("end", resolve)
            .on("error", reject);
        });
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, `compressed_${originalName}`);
      }

      // Other files: zip up
      const zipPath = outputPath.replace(/\.[^/.]+$/, ".zip");
      const outStream = fs.createWriteStream(zipPath);
      const archive = archiver("zip");
      archive.pipe(outStream);
      archive.file(inputPath, { name: originalName });
      await archive.finalize();
      safeUnlink(inputPath);
      scheduleDelete(zipPath);
      return sendAndCleanup(res, zipPath, `${path.basename(originalName)}.zip`);
    }

    // ===== CONVERT MODE =====
    // IMAGE -> IMAGE or IMAGE -> PDF
    if (req.file.mimetype.startsWith("image/") && ["jpg","jpeg","png","webp","tiff","bmp","gif","pdf"].includes(outputExt)) {
      if (outputExt === "pdf") {
        // embed image into PDF
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
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.pdf`);
      } else {
        // image -> image via sharp
        const fmt = outputExt === "jpg" ? "jpeg" : outputExt;
        await sharp(inputPath).toFormat(fmt).toFile(outputPath);
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      }
    }

    // PDF -> IMAGE via pdftoppm (poppler)
    if (inputExt === "pdf" && ["jpg","jpeg","png","webp","tiff","bmp"].includes(outputExt)) {
      if (!HAS.pdftoppm) return missingToolsResponse(res, ["pdftoppm (poppler-utils)"]);
      const base = path.join(PROCESSED, nowBase);
      const flag = outputExt === "jpg" ? "jpeg" : outputExt;
      const cmd = `pdftoppm -${flag} -singlefile "${inputPath}" "${base}"`;
      await execP(cmd);
      // pdftoppm produces base.[png/jpg/...]
      const produced = `${base}.${flag}`;
      if (!fs.existsSync(produced)) {
        // try alternate extension
        const alt = `${base}.${outputExt}`;
        if (fs.existsSync(alt)) {
          safeUnlink(inputPath);
          scheduleDelete(alt);
          return sendAndCleanup(res, alt, `${path.basename(originalName, ".pdf")}.${outputExt}`);
        }
        throw new Error("pdftoppm did not produce output.");
      }
      safeUnlink(inputPath);
      scheduleDelete(produced);
      return sendAndCleanup(res, produced, `${path.basename(originalName, ".pdf")}.${outputExt}`);
    }

    // IMAGE -> PDF (covered above), IMAGE -> IMAGE covered.

    // DOCX/ODT -> PDF/HTML/TXT via unoconv/libreoffice when available
    if (["doc","docx","odt"].includes(inputExt)) {
      if (HAS.unoconv || HAS.libreoffice) {
        // prefer unoconv
        const expectedOut = path.join(PROCESSED, `${path.basename(inputPath, path.extname(inputPath))}.${outputExt}`);
        if (HAS.unoconv) {
          const cmd = `unoconv -f ${outputExt} -o "${expectedOut}" "${inputPath}"`;
          await execP(cmd);
        } else {
          const cmd = `libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir "${PROCESSED}"`;
          await execP(cmd);
        }
        // try to find produced file
        const produced = fs.existsSync(expectedOut) ? expectedOut :
                         path.join(PROCESSED, `${path.basename(inputPath, path.extname(inputPath))}.${outputExt}`);
        if (!fs.existsSync(produced)) throw new Error("LibreOffice/unoconv did not produce output.");
        safeUnlink(inputPath);
        scheduleDelete(produced);
        return sendAndCleanup(res, produced, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      } else {
        // fallback: mammoth to HTML/TXT only
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
        } else {
          return missingToolsResponse(res, ["libreoffice/unoconv (required for DOCX→" + outputExt + ")"]);
        }
      }
    }

    // TXT/MD/HTML conversions
    if (["txt","md","html"].includes(inputExt)) {
      const content = fs.readFileSync(inputPath, "utf8");
      if (["txt","md","html"].includes(outputExt)) {
        // simple pass-through or light md->html fallback
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
          return missingToolsResponse(res, ["libreoffice/unoconv (required for TXT/HTML→PDF)"]);
        }
      }
    }

    // AUDIO/VIDEO conversions
    if ((req.file.mimetype.startsWith("audio/") || req.file.mimetype.startsWith("video/")) &&
        ["mp4","mp3","wav","ogg","webm","mkv","mov","avi"].includes(outputExt)) {
      if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
      await new Promise((resolve, reject) => {
        const proc = ffmpeg(inputPath);
        if (outputExt === "webm") proc.outputOptions(["-c:v libvpx-vp9 -b:v 1M -c:a libopus"]);
        else if (outputExt === "mp4") proc.outputOptions(["-c:v libx264 -preset fast -c:a aac"]);
        proc.toFormat(outputExt).save(outputPath).on("end", resolve).on("error", reject);
      });
      safeUnlink(inputPath);
      scheduleDelete(outputPath);
      return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
    }

    // Generic fallback: copy and return
    fs.copyFileSync(inputPath, outputPath);
    safeUnlink(inputPath);
    scheduleDelete(outputPath);
    return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);

  } catch (err) {
    console.error("Conversion error:", err && err.stack ? err.stack : err);
    safeUnlink(inputPath);
    return res.status(500).json({ error: "Conversion failed on server.", details: String(err) });
  }
});

module.exports = router;
  
