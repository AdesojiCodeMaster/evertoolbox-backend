// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);



const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Ensure processed folder exists
if (!fs.existsSync("processed")) fs.mkdirSync("processed");

// ✅ Helper for safe file cleanup
const safeUnlink = (p) => fs.existsSync(p) && fs.unlinkSync(p);

// ✅ Utility to generate processed file path
const outputFile = (ext) => path.join("processed", `result_${Date.now()}.${ext}`);

// ✅ Main route
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const { mode, targetFormat } = req.body;
    const inputFile = req.file.path;
    const originalName = req.file.originalname;
    const inputExt = path.extname(originalName).slice(1).toLowerCase();
    const outputExt = (targetFormat || inputExt).toLowerCase();
    const outputPath = outputFile(outputExt);

    if (!inputFile) return res.status(400).send("No file uploaded.");

    // ========== 🔹 COMPRESSION MODE ==========
    if (mode === "compress") {
      let cmd;
      if (["jpg", "jpeg", "png", "webp"].includes(inputExt)) {
        cmd = `convert "${inputFile}" -quality 75 "${outputPath}"`;
      } else if (["mp4", "mov", "avi", "mkv", "webm"].includes(inputExt)) {
        cmd = `ffmpeg -y -i "${inputFile}" -b:v 1M -b:a 128k "${outputPath}"`;
      } else if (["mp3", "wav", "ogg", "flac", "aac"].includes(inputExt)) {
        cmd = `ffmpeg -y -i "${inputFile}" -b:a 128k "${outputPath}"`;
      } else if (["pdf"].includes(inputExt)) {
        cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputFile}"`;
      } else {
        safeUnlink(inputFile);
        return res.status(400).send("Unsupported file type for compression.");
      }

      exec(cmd, (err) => {
        safeUnlink(inputFile);
        if (err) return res.status(500).send("Compression failed.");
        res.download(outputPath, () => safeUnlink(outputPath));
      });
      return;
    }

    // ========== 🔹 CONVERSION MODE ==========
    let cmd;

    // ----- IMAGE CONVERSIONS -----
    if (["jpg", "jpeg", "png", "webp", "tiff", "bmp", "gif"].includes(inputExt) &&
        ["jpg", "jpeg", "png", "webp", "tiff", "bmp", "gif", "pdf"].includes(outputExt)) {
      cmd = `convert "${inputFile}" "${outputPath}"`;
    }

    // ----- PDF → IMAGE -----
    else if (inputExt === "pdf" && ["jpg", "jpeg", "png", "webp", "tiff", "bmp"].includes(outputExt)) {
      const fmt = outputExt === "jpg" ? "jpeg" : outputExt;
      cmd = `pdftoppm -${fmt} -singlefile "${inputFile}" "${outputPath.replace(/\.[^.]+$/, "")}"`;
    }

    // ----- DOCUMENT ↔ PDF -----
    else if (["pdf", "doc", "docx", "odt", "txt", "html", "md"].includes(inputExt) &&
             ["pdf", "docx", "odt", "txt", "html", "md"].includes(outputExt)) {
      cmd = `libreoffice --headless --convert-to ${outputExt} "${inputFile}" --outdir processed`;
    }

    // ----- AUDIO ↔ AUDIO -----
    else if (["mp3", "wav", "ogg", "flac", "aac"].includes(inputExt) &&
             ["mp3", "wav", "ogg", "flac", "aac"].includes(outputExt)) {
      cmd = `ffmpeg -y -i "${inputFile}" "${outputPath}"`;
    }

    // ----- VIDEO ↔ VIDEO -----
    else if (["mp4", "mov", "avi", "mkv", "webm"].includes(inputExt) &&
             ["mp4", "mov", "avi", "mkv", "webm"].includes(outputExt)) {
      if (outputExt === "webm") {
        cmd = `ffmpeg -y -i "${inputFile}" -c:v libvpx-vp9 -b:v 1M -c:a libopus "${outputPath}"`;
      } else if (outputExt === "mp4") {
        cmd = `ffmpeg -y -i "${inputFile}" -c:v libx264 -preset fast -c:a aac "${outputPath}"`;
      } else {
        cmd = `ffmpeg -y -i "${inputFile}" "${outputPath}"`;
      }
    }

    else {
      safeUnlink(inputFile);
      return res.status(400).send("Unsupported file conversion type.");
    }

    exec(cmd, (err) => {
      if (err) {
        console.error("❌ Conversion failed:", err);
        safeUnlink(inputFile);
        return res.status(500).send("Conversion failed.");
      }

      // LibreOffice saves directly to processed/, so handle that
      if (cmd.includes("libreoffice")) {
        const produced = path.join("processed", path.basename(originalName, path.extname(originalName)) + "." + outputExt);
        res.download(produced, () => safeUnlink(produced));
      } else {
        res.download(outputPath, () => safeUnlink(outputPath));
      }
      safeUnlink(inputFile);
    });

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error during processing.");
  }
});

module.exports = router;
        
