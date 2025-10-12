// universal-filetool.js
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { PDFDocument, StandardFonts } = require("pdf-lib");

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();
const upload = multer({ dest: os.tmpdir() });

// Health check
router.get("/api/tools/file/health", (req, res) => {
  res.json({ status: "ok", tool: "EverToolbox FileTool" });
});

// File processing route
router.post("/api/tools/file/process", upload.single("file"), async (req, res) => {
  try {
    const { action, targetFormat, quality } = req.body;
    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase().replace(".", "");
    const outFormat = targetFormat || ext;
    const outPath = path.join(os.tmpdir(), `${Date.now()}.${outFormat}`);
    const q = Math.min(Math.max(parseInt(quality) || 80, 10), 100);

    // --- COMPRESSION LOGIC ---
    if (action === "compress") {
      if (["jpg", "jpeg", "png", "webp", "avif"].includes(ext)) {
        await sharp(filePath)
          .toFormat(ext, { quality: q })
          .toFile(outPath);
      } else if (ext === "pdf") {
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const compressed = await pdfDoc.save({ useObjectStreams: true });
        fs.writeFileSync(outPath, compressed);
      } else if (["mp3", "wav", "ogg", "mp4", "webm", "mov"].includes(ext)) {
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputOptions(["-b:v 800k", "-b:a 96k"])
            .save(outPath)
            .on("end", resolve)
            .on("error", reject);
        });
      } else {
        fs.copyFileSync(filePath, outPath);
      }
    }

    // --- CONVERSION LOGIC ---
    else if (action === "convert") {
      if (["jpg", "jpeg", "png", "webp", "avif"].includes(outFormat)) {
        await sharp(filePath)
          .toFormat(outFormat, { quality: q })
          .toFile(outPath);
      } else if (outFormat === "pdf") {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
          const imgBytes = fs.readFileSync(filePath);
          const img = ext === "png"
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes);
          const imgDims = img.scaleToFit(width, height);
          page.drawImage(img, { x: 0, y: 0, width: imgDims.width, height: imgDims.height });
        } else {
          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          page.drawText(`Converted to PDF from ${originalName}`, {
            x: 40, y: height / 2, size: 14, font,
          });
        }
        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(outPath, pdfBytes);
      } else if (["mp3", "wav", "ogg", "mp4", "webm", "mov"].includes(outFormat)) {
        await new Promise((resolve, reject) => {
          ffmpeg(filePath).toFormat(outFormat).save(outPath).on("end", resolve).on("error", reject);
        });
      } else if (["txt", "html", "md", "docx"].includes(outFormat)) {
        const text = fs.readFileSync(filePath, "utf8");
        fs.writeFileSync(outPath, text);
      } else {
        fs.copyFileSync(filePath, outPath);
      }
    } else {
      fs.copyFileSync(filePath, outPath);
    }

    // Send back processed file
    const stat = fs.statSync(outPath);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(originalName, path.extname(originalName))}.${outFormat}"`
    );
    res.setHeader("Content-Length", stat.size);
    res.sendFile(outPath);
  } catch (err) {
    console.error("Error processing file:", err);
    res.status(500).json({ error: "File processing failed: " + err.message });
  }
});

module.exports = router;
          
