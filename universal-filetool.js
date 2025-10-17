// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { exec } = require("child_process");

const router = express.Router();

// Setup Multer
const upload = multer({ dest: "uploads/" });

// Utility function
function cleanupFiles(...files) {
  for (const f of files) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// Main route
router.post("/file", upload.single("file"), async (req, res) => {
  try {
    const { targetFormat, action } = req.body;
    const inputPath = req.file.path;
    const inputExt = path.extname(req.file.originalname).toLowerCase();
    const outputFile = `${Date.now()}.${targetFormat}`;
    const outputPath = path.join("processed", outputFile);

    if (!targetFormat) {
      cleanupFiles(inputPath);
      return res.status(400).json({ error: "No target format specified" });
    }

    // --- Handle compression ---
    if (action === "compress") {
      if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(inputExt)) {
        await sharp(inputPath).jpeg({ quality: 60 }).toFile(outputPath);
      } else if ([".mp3", ".wav", ".ogg"].includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .audioBitrate("128k")
            .toFormat(inputExt.replace(".", ""))
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
      } else if ([".mp4", ".avi", ".mov", ".webm"].includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .videoBitrate("800k")
            .toFormat(inputExt.replace(".", ""))
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
      } else {
        cleanupFiles(inputPath);
        return res.status(400).json({ error: "Unsupported compression type" });
      }
    }

    // --- Handle conversions ---
    else if (action === "convert") {
      // IMAGE ↔ IMAGE
      if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(inputExt)) {
        // IMAGE → PDF (new)
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const stream = fs.createWriteStream(outputPath);
          doc.pipe(stream);

          const img = sharp(inputPath);
          const metadata = await img.metadata();
          const buffer = await img.toBuffer();

          doc.addPage({ size: [metadata.width, metadata.height] });
          doc.image(buffer, 0, 0, {
            width: metadata.width,
            height: metadata.height,
          });
          doc.end();

          await new Promise((resolve) => stream.on("finish", resolve));
        } else {
          // IMAGE → IMAGE
          await sharp(inputPath)
            .toFormat(targetFormat)
            .toFile(outputPath);
        }
      }

      // AUDIO ↔ AUDIO
      else if ([".mp3", ".wav", ".ogg"].includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .toFormat(targetFormat)
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
      }

      // VIDEO ↔ VIDEO
      else if ([".mp4", ".avi", ".mov", ".webm"].includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .toFormat(targetFormat)
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
      }

      // DOCUMENT ↔ DOCUMENT (unoconv)
      else if ([".pdf", ".docx", ".txt", ".md"].includes(inputExt)) {
        await new Promise((resolve, reject) => {
          exec(
            `unoconv -f ${targetFormat} -o ${outputPath} ${inputPath}`,
            (err) => (err ? reject(err) : resolve())
          );
        });
      }

      else {
        cleanupFiles(inputPath);
        return res.status(400).json({ error: "Unsupported conversion type" });
      }
    }

    // Send success
    cleanupFiles(inputPath);
    return res.download(outputPath, outputFile, () => cleanupFiles(outputPath));

  } catch (err) {
    console.error("❌ Conversion failed:", err);
    return res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;
