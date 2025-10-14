// universal-filetool.js
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function cleanup(file) {
  if (fs.existsSync(file)) fs.unlink(file, () => {});
}

async function compressBuffer(buffer, type, quality = 80) {
  if (type.startsWith("image/")) {
    return await sharp(buffer)
      .jpeg({ quality: Math.min(quality, 90) })
      .toBuffer();
  }
  return buffer.slice(0, Math.floor(buffer.length * 0.8)); // fallback
}

router.post("/process", upload.single("file"), async (req, res) => {
  const { action, targetFormat, quality = 80 } = req.body;
  const input = req.file;
  const filePath = input.path;
  const mime = input.mimetype;
  const originalExt = path.extname(input.originalname).slice(1);

  try {
    let outBuffer;
    let outMime = mime;
    let ext = targetFormat || originalExt;
    const filename = `result.${ext}`;

    // Validation
    if (!action)
      return res.status(400).json({ error: "Please select an action." });
    if (action === "convert" && !targetFormat)
      return res
        .status(400)
        .json({ error: "Please select a target format for conversion." });
    if (action === "convert" && targetFormat === originalExt)
      return res
        .status(400)
        .json({ error: "Source and target formats cannot be the same." });

    // ✅ Compression
    if (action === "compress") {
      if (mime.startsWith("image/")) {
        outBuffer = await compressBuffer(fs.readFileSync(filePath), mime, quality);
      } else if (mime.startsWith("audio/")) {
        const outPath = `${filePath}_compressed.${originalExt}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .audioBitrate("96k") // reduce bitrate
            .on("end", resolve)
            .on("error", reject)
            .save(outPath);
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
      } else if (mime.startsWith("video/")) {
        const outPath = `${filePath}_compressed.${originalExt}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .videoCodec("libx264")
            .videoBitrate("1000k") // reduce bitrate
            .outputOptions(["-preset veryfast", "-crf 28"])
            .on("end", resolve)
            .on("error", reject)
            .save(outPath);
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
      } else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    // ✅ Conversion
    else if (action === "convert") {
      if (mime.startsWith("image/")) {
        const image = sharp(filePath);
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on("data", (d) => chunks.push(d));
          doc.on("end", () => {
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Type", "application/pdf");
            res.end(Buffer.concat(chunks));
            cleanup(filePath);
          });
          const { width, height } = await image.metadata();
          doc.addPage({ size: [width, height] });
          const imgBuffer = await image.jpeg({ quality: +quality }).toBuffer();
          doc.image(imgBuffer, 0, 0, { width, height });
          doc.end();
          return;
        } else {
          outBuffer = await image.toFormat(targetFormat, { quality: +quality }).toBuffer();
          outMime = `image/${targetFormat}`;
        }
      } else if (mime.includes("text") || mime.includes("html")) {
        const text = fs.readFileSync(filePath, "utf8");
        if (targetFormat === "pdf") {
          const doc = new PDFDocument();
          const chunks = [];
          doc.on("data", (d) => chunks.push(d));
          doc.on("end", () => {
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Type", "application/pdf");
            res.end(Buffer.concat(chunks));
            cleanup(filePath);
          });
          doc.fontSize(12).text(text);
          doc.end();
          return;
        } else {
          outBuffer = Buffer.from(text, "utf8");
          outMime = "text/plain";
        }
      } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        const outPath = `${filePath}.${targetFormat}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .output(outPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
        });
        outBuffer = fs.readFileSync(outPath);
        cleanup(outPath);
        outMime = mime.startsWith("audio/")
          ? `audio/${targetFormat}`
          : `video/${targetFormat}`;
      }
    }

    cleanup(filePath);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", outMime);
    res.end(outBuffer);
  } catch (e) {
    console.error("❌ Error:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
    
