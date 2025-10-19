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

const UPLOADS = path.join(__dirname, "uploads");
const PROCESSED = path.join(__dirname, "processed");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PROCESSED)) fs.mkdirSync(PROCESSED, { recursive: true });

const upload = multer({ dest: UPLOADS, limits: { fileSize: 1024 * 1024 * 300 } });

function whichSync(cmd) {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const HAS = {
  ffmpeg: whichSync("ffmpeg"),
  pdftoppm: whichSync("pdftoppm"),
  libreoffice: whichSync("libreoffice") || whichSync("soffice"),
  unoconv: whichSync("unoconv"),
  convert: whichSync("convert")
};

function missingToolsResponse(res, tools) {
  return res.status(501).json({
    error: "Required system tools are missing for this conversion.",
    missing: tools
  });
}

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

function scheduleDelete(filePath, ms = 1000 * 60 * 60 * 3) {
  setTimeout(() => safeUnlink(filePath), ms);
}

function sendAndCleanup(res, filePath, downloadName) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found." });
  }
  const name = downloadName || path.basename(filePath);
  const finalName = name.includes('.') ? name : name + path.extname(filePath);
  res.download(filePath, finalName, (err) => {
    if (err) console.error("Download error:", err);
    scheduleDelete(filePath, 1000 * 60 * 30);
  });
}

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

  // same format protection
  if (mode === "convert" && inputExt === outputExt) {
    safeUnlink(inputPath);
    return res.status(400).json({ error: `File is already in ${outputExt.toUpperCase()} format.` });
  }

  try {
    // ===== COMPRESS MODE =====
    if (mode === "compress") {
      // Image compression
      if (req.file.mimetype.startsWith("image/")) {
        const quality = Math.max(20, Math.min(85, parseInt(req.body.quality || "60")));
        await sharp(inputPath).jpeg({ quality }).toFile(outputPath);
        const oldSize = fs.statSync(inputPath).size;
        const newSize = fs.statSync(outputPath).size;
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return res.json({
          message: "Image compressed successfully.",
          originalSizeMB: (oldSize / 1024 / 1024).toFixed(2),
          compressedSizeMB: (newSize / 1024 / 1024).toFixed(2),
          download: `/api/tools/file/download/${path.basename(outputPath)}`
        });
      }

      // Audio/video compression
      if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions(["-b:v 800k", "-b:a 96k"])
            .save(outputPath)
            .on("end", resolve).on("error", reject);
        });
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, `compressed_${originalName}`);
      }

      // Other files → zip
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
    // IMAGE → PDF
    if (req.file.mimetype.startsWith("image/") && outputExt === "pdf") {
      const pdfDoc = await PDFDocument.create();
      const imageBuf = fs.readFileSync(inputPath);
      const img = await pdfDoc.embedJpg(imageBuf).catch(async () => await pdfDoc.embedPng(imageBuf));
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      const pdfBytes = await pdfDoc.save();
      fs.writeFileSync(outputPath, pdfBytes);
      safeUnlink(inputPath);
      scheduleDelete(outputPath);
      return sendAndCleanup(res, outputPath, `${path.basename(originalName)}.pdf`);
    }

    // PDF → IMAGE
    if (inputExt === "pdf" && ["jpg", "jpeg", "png"].includes(outputExt)) {
      if (!HAS.pdftoppm) return missingToolsResponse(res, ["pdftoppm (poppler-utils)"]);
      const base = path.join(PROCESSED, nowBase);
      await execP(`pdftoppm -${outputExt === "jpg" ? "jpeg" : outputExt} -singlefile "${inputPath}" "${base}"`);
      const produced = `${base}.${outputExt === "jpg" ? "jpeg" : outputExt}`;
      safeUnlink(inputPath);
      scheduleDelete(produced);
      return sendAndCleanup(res, produced, `${path.basename(originalName, ".pdf")}.${outputExt}`);
    }

    // DOCX → PDF/TXT/HTML
    if (["doc", "docx", "odt"].includes(inputExt)) {
      if (HAS.unoconv || HAS.libreoffice) {
        const cmd = HAS.unoconv
          ? `unoconv -f ${outputExt} -o "${outputPath}" "${inputPath}"`
          : `libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir "${PROCESSED}"`;
        await execP(cmd);
        safeUnlink(inputPath);
        scheduleDelete(outputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      } else {
        return missingToolsResponse(res, ["LibreOffice or unoconv"]);
      }
    }

    // AUDIO/VIDEO conversion
    if ((req.file.mimetype.startsWith("audio/") || req.file.mimetype.startsWith("video/")) &&
      ["mp4", "mp3", "wav", "ogg", "webm", "mkv"].includes(outputExt)) {
      if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath).toFormat(outputExt).save(outputPath)
          .on("end", resolve).on("error", reject);
      });
      safeUnlink(inputPath);
      scheduleDelete(outputPath);
      return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
    }

    // fallback
    fs.copyFileSync(inputPath, outputPath);
    safeUnlink(inputPath);
    scheduleDelete(outputPath);
    return sendAndCleanup(res, outputPath, `${path.basename(originalName)}.${outputExt}`);

  } catch (err) {
    console.error("Conversion error:", err);
    safeUnlink(inputPath);
    return res.status(500).json({ error: "Conversion failed.", details: err.message });
  }
});

module.exports = router;
