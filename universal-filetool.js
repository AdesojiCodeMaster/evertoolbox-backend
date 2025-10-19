// universal-filetool.js
// Backend logic for file conversion and compression
// Cleaned and syntax-verified version — no logic changes

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const router = express.Router();

const upload = multer({ dest: "uploads/" });

// Utility: delete a file if it exists
const safeDelete = (filePath) => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

// Utility: generate unique file name
const uniqueName = (base, ext) => {
  const stamp = Date.now();
  return `${base}_${stamp}${ext}`;
};

// Allowed conversion formats
const allowedFormats = [
  "mp3", "wav", "aac", "flac",
  "mp4", "mov", "avi", "mkv",
  "pdf", "png", "jpg", "jpeg",
  "webp", "gif", "txt", "docx"
];

// Route: convert file
router.post("/convert", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const { format } = req.body;

    if (!file) return res.status(400).json({ error: "No file uploaded." });
    if (!format) return res.status(400).json({ error: "No target format specified." });

    const inputPath = file.path;
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext);
    const outputName = `${baseName}.${format}`;
    const outputPath = path.join("outputs", outputName);

    // Prevent same-format conversion
    if (ext.replace(".", "") === format) {
      safeDelete(inputPath);
      return res.status(400).json({
        error: "Cannot convert to the same format as the uploaded file."
      });
    }

    if (!allowedFormats.includes(format)) {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Unsupported conversion format." });
    }

    if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

    let command;

    // Determine conversion method
    if (["mp3", "wav", "aac", "flac"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
    } else if (["mp4", "mov", "avi", "mkv"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" -c:v libx264 "${outputPath}"`;
    } else if (["jpg", "jpeg", "png", "webp", "gif"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
    } else if (format === "pdf") {
      command = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir outputs`;
    } else if (format === "txt" || format === "docx") {
      command = `libreoffice --headless --convert-to ${format} "${inputPath}" --outdir outputs`;
    } else {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Unsupported conversion type." });
    }

    exec(command, (error) => {
      safeDelete(inputPath);
      if (error) {
        console.error("Conversion error:", error);
        return res.status(500).json({ error: "Conversion failed from server." });
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: "Output file not found after conversion." });
      }

      res.download(outputPath, outputName, (err) => {
        if (err) console.error("Download error:", err);
        safeDelete(outputPath);
      });
    });
  } catch (err) {
    console.error("Conversion route error:", err);
    res.status(500).json({ error: "Unexpected server error during conversion." });
  }
});

// Route: compress file
router.post("/compress", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) return res.status(400).json({ error: "No file uploaded." });

    const inputPath = file.path;
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext);
    const outputName = `${baseName}_compressed${ext}`;
    const outputPath = path.join("outputs", outputName);

    if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

    let command;

    // Determine compression method
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      command = `ffmpeg -y -i "${inputPath}" -compression_level 2 -q:v 25 "${outputPath}"`;
    } else if ([".mp3", ".wav", ".aac", ".flac"].includes(ext)) {
      command = `ffmpeg -y -i "${inputPath}" -b:a 96k "${outputPath}"`;
    } else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
      command = `ffmpeg -y -i "${inputPath}" -b:v 1000k "${outputPath}"`;
    } else if ([".pdf"].includes(ext)) {
      command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
    } else {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Unsupported compression format." });
    }

    exec(command, (error) => {
      safeDelete(inputPath);
      if (error) {
        console.error("Compression error:", error);
        return res.status(500).json({ error: "Compression failed from server." });
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: "Output file not found after compression." });
      }

      res.download(outputPath, outputName, (err) => {
        if (err) console.error("Download error:", err);
        safeDelete(outputPath);
      });
    });
  } catch (err) {
    console.error("Compression route error:", err);
    res.status(500).json({ error: "Unexpected server error during compression." });
  }
});

module.exports = router;
      
