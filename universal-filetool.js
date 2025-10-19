// universal-filetool.js
// Backend logic for conversion & compression with PDF-to-image support

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const router = express.Router();

const upload = multer({ dest: "uploads/" });

// Helper functions
const safeDelete = (filePath) => {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
};

// Conversion Route
router.post("/convert", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const { format } = req.body;

    if (!file) return res.status(400).json({ error: "No file uploaded." });
    if (!format) return res.status(400).json({ error: "No target format provided." });

    const inputPath = file.path;
    const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
    const baseName = path.basename(file.originalname, path.extname(file.originalname));
    const outputName = `${baseName}.${format}`;
    const outputPath = path.join("outputs", outputName);

    if (ext === format) {
      safeDelete(inputPath);
      return res.status(400).json({
        error: "Cannot convert to the same format as the uploaded file."
      });
    }

    ensureDir("outputs");

    let command;

    // AUDIO CONVERSION
    if (["mp3", "wav", "aac", "flac"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
    }
    // VIDEO CONVERSION
    else if (["mp4", "webm", "mov", "avi", "mkv"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" -c:v libx264 "${outputPath}"`;
    }
    // IMAGE CONVERSION
    else if (["jpg", "jpeg", "png", "webp", "gif"].includes(format)) {
      command = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
    }
    // DOCUMENT / PDF CONVERSION
    else if (["pdf", "txt", "docx"].includes(format)) {
      command = `libreoffice --headless --convert-to ${format} "${inputPath}" --outdir outputs`;
    }
    // PDF TO IMAGE CONVERSION
    else if (format === "image") {
      const baseOut = path.join("outputs", `${baseName}-%03d.png`);
      command = `pdftoppm "${inputPath}" "${baseName}" -png && mv ${baseName}-*.png outputs/`;
    }
    else {
      safeDelete(inputPath);
      return res.status(400).json({ error: "Unsupported conversion format." });
    }

    exec(command, (error) => {
      safeDelete(inputPath);

      if (error) {
        console.error("Conversion error:", error);
        return res.status(500).json({ error: "Conversion failed from server." });
      }

      if (!fs.existsSync(outputPath)) {
        const generated = fs.readdirSync("outputs").find(f => f.startsWith(baseName));
        if (generated) return res.download(path.join("outputs", generated), generated, () => safeDelete(path.join("outputs", generated)));
        return res.status(500).json({ error: "Output not found after conversion." });
      }

      res.download(outputPath, outputName, (err) => {
        if (err) console.error("Download error:", err);
        safeDelete(outputPath);
      });
    });
  } catch (err) {
    console.error("Conversion route error:", err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

// Compression Route
router.post("/compress", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded." });

    const inputPath = file.path;
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext);
    const outputName = `${baseName}_compressed${ext}`;
    const outputPath = path.join("outputs", outputName);

    ensureDir("outputs");
    let command;

    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      command = `ffmpeg -y -i "${inputPath}" -compression_level 2 -q:v 28 "${outputPath}"`;
    } else if ([".mp3", ".wav", ".aac", ".flac"].includes(ext)) {
      command = `ffmpeg -y -i "${inputPath}" -b:a 96k "${outputPath}"`;
    } else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) {
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
        return res.status(500).json({ error: "Output file missing after compression." });
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
        
