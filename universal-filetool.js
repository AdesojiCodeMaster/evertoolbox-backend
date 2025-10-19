// -------------------------------------------------------
// 🧰 EverToolbox Universal File Tool (CommonJS Version)
// Handles: Conversion + Compression (images, audio, video, documents)
// Single file, correct naming, direct download, no zips or folders
// -------------------------------------------------------

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const mime = require("mime-types");
const ffmpeg = require('fluent-ffmpeg');



const router = express.Router();
const execPromise = util.promisify(exec);


// ---- TEMP STORAGE ----
const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

// -------------------------------------------------------
// Helper: Safe delete temp files
function safeDelete(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.warn("Temp delete failed:", filePath, err.message);
    });
  }
}

// -------------------------------------------------------
// Helper: Output name generator
function getOutputFileName(original, prefix, newExt) {
  const base = path.parse(original).name;
  return `${prefix}_${base}.${newExt}`;
}

// -------------------------------------------------------
// Helper: Conversion command (for conversion)
function getConversionCommand(inputPath, outputPath) {
  const inputExt = path.extname(inputPath).toLowerCase();
  const outputExt = path.extname(outputPath).toLowerCase();

  // 🔹 Document conversion via LibreOffice
  const documentExts = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".ods", ".txt"];
  if (documentExts.includes(inputExt) || documentExts.includes(outputExt)) {
    return `libreoffice --headless --convert-to ${outputExt.replace(".", "")} --outdir outputs "${inputPath}"`;
  }

  // 🔹 Other formats via ffmpeg
  return `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
}

// -------------------------------------------------------
// Helper: Compression command
function getCompressionCommand(inputPath, outputPath, mimeType) {
  if (mimeType.startsWith("image/")) {
    return `ffmpeg -y -i "${inputPath}" -qscale:v 7 "${outputPath}"`;
  }
  if (mimeType.startsWith("audio/")) {
    return `ffmpeg -y -i "${inputPath}" -b:a 128k "${outputPath}"`;
  }
  if (mimeType.startsWith("video/")) {
    return `ffmpeg -y -i "${inputPath}" -vcodec libx264 -crf 28 -preset veryfast -acodec aac -b:a 128k "${outputPath}"`;
  }
  if (mimeType === "application/pdf") {
    return `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
  }

  // Fallback for unsupported compression
  return `cp "${inputPath}" "${outputPath}"`;
}

// -------------------------------------------------------
// 🧩 Main route handler
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const { action, targetFormat } = req.body;
    const inputPath = req.file.path;
    const mimeType = mime.lookup(req.file.originalname) || "application/octet-stream";
    const originalExt = path.extname(req.file.originalname).toLowerCase().replace(".", "");

    console.log(`[${action}] Processing: ${req.file.originalname}`);

    // Ensure only one file
    if (Array.isArray(req.files) && req.files.length > 1) {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Please upload one file at a time." });
    }

    // Prevent same-format conversion
    if (action === "convert" && targetFormat && targetFormat.toLowerCase() === originalExt) {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Target format must differ from original format." });
    }

    const outputExt = action === "convert" && targetFormat ? targetFormat : originalExt;
    const prefix = action === "compress" ? "compressed" : "converted";
    const outputFileName = getOutputFileName(req.file.originalname, prefix, outputExt);
    const outputPath = path.join("outputs", outputFileName);

    // Build command
    let command;
    if (action === "compress") {
      command = getCompressionCommand(inputPath, outputPath, mimeType);
    } else if (action === "convert") {
      command = getConversionCommand(inputPath, outputPath);
    } else {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Invalid action." });
    }

    console.log("Running:", command);

    await execPromise(command);

    if (!fs.existsSync(outputPath)) {
      throw new Error("Output file not created. Conversion failed on server.");
    }

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error("Generated file is empty.");
    }

    // Send direct file (naked)
    res.setHeader("Content-Disposition", `attachment; filename="${outputFileName}"`);
    res.setHeader("Content-Type", mime.lookup(outputFileName) || "application/octet-stream");
    res.sendFile(path.resolve(outputPath), (err) => {
      safeDelete(inputPath);
      safeDelete(outputPath);
      if (err) console.error("Send error:", err);
    });
  } catch (err) {
    console.error("Processing error:", err);
    res.status(500).json({ error: err.message || "Conversion failed on server." });
  }
});

module.exports = router;
