// universal-filetool.js — FINAL VERSION
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Helper: cleanup
function cleanup(file) {
  if (fs.existsSync(file)) fs.unlink(file, () => {});
}

// Image compression
async function compressImage(buffer, mime) {
  if (mime.includes("jpeg") || mime.includes("jpg"))
    return sharp(buffer).jpeg({ quality: 70 }).toBuffer();
  if (mime.includes("png"))
    return sharp(buffer).png({ compressionLevel: 9 }).toBuffer();
  if (mime.includes("webp"))
    return sharp(buffer).webp({ quality: 70 }).toBuffer();
  return buffer;
}

// Simple text compression
function compressText(content) {
  return content.replace(/\s+/g, " ");
}

router.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: "No file uploaded." });

    const { action, targetFormat = "", quality = 80 } = req.body;
    const file = req.file;
    const filePath = file.path;
    const mime = file.mimetype;
    const baseName = path.parse(file.originalname).name;
    const outExt = targetFormat || mime.split("/")[1] || "out";
    const outPath = path.join("outputs", `${baseName}.${outExt}`);

    fs.mkdirSync("outputs", { recursive: true });

    let outBuffer = null;

    // IMAGE
    if (mime.startsWith("image/")) {
      const image = sharp(filePath);
      if (action === "compress") {
        outBuffer = await compressImage(fs.readFileSync(filePath), mime);
      } else if (action === "convert") {
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on("data", (d) => chunks.push(d));
          doc.on("end", () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader("Content-Disposition", `attachment; filename="${baseName}.pdf"`);
            res.setHeader("Content-Type", "application/pdf");
            res.end(buffer);
            cleanup(filePath);
          });
          const meta = await image.metadata();
          doc.addPage({ size: [meta.width, meta.height] });
          const imgBuffer = await image.jpeg({ quality: +quality }).toBuffer();
          doc.image(imgBuffer, 0, 0, { width: meta.width, height: meta.height });
          doc.end();
          return;
        } else {
          outBuffer = await image.toFormat(targetFormat, { quality: +quality }).toBuffer();
        }
      }
    }

    // TEXT/DOC
    else if (mime.includes("text") || mime.includes("html") || mime.includes("json")) {
      const text = fs.readFileSync(filePath, "utf8");
      let content = text;
      if (action === "compress") content = compressText(text);

      if (targetFormat === "pdf") {
        const doc = new PDFDocument();
        const chunks = [];
        doc.on("data", (d) => chunks.push(d));
        doc.on("end", () => {
          const buffer = Buffer.concat(chunks);
          res.setHeader("Content-Disposition", `attachment; filename="${baseName}.pdf"`);
          res.setHeader("Content-Type", "application/pdf");
          res.end(buffer);
          cleanup(filePath);
        });
        doc.fontSize(12).text(content);
        doc.end();
        return;
      } else {
        outBuffer = Buffer.from(content, "utf8");
      }
    }

    // AUDIO/VIDEO
    else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      const outFile = `${filePath}.${targetFormat || "out"}`;
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(filePath);
        if (action === "compress") {
          if (mime.startsWith("audio/")) {
            cmd.audioBitrate("96k").toFormat("mp3");
          } else {
            cmd.videoBitrate("1000k")
              .outputOptions(["-preset veryfast", "-movflags +faststart"])
              .toFormat(targetFormat || "mp4");
          }
        } else if (action === "convert" && targetFormat) {
          cmd.toFormat(targetFormat);
        }
        cmd.on("end", resolve).on("error", reject).save(outFile);
      });
      outBuffer = fs.readFileSync(outFile);
      cleanup(outFile);
    } else {
      cleanup(filePath);
      return res.status(400).json({ success: false, message: "Unsupported file type." });
    }

    cleanup(filePath);
    fs.writeFileSync(outPath, outBuffer);
    res.json({
      success: true,
      message: `${action === "compress" ? "Compression" : "Conversion"} successful!`,
      download: `/api/tools/file/download/${path.basename(outPath)}`,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, message: "Processing failed. Try again." });
  }
});

router.get("/download/:filename", (req, res) => {
  const filePath = path.join("outputs", req.params.filename);
  if (fs.existsSync(filePath)) return res.download(filePath);
  return res.status(404).json({ success: false, message: "File not found." });
});

module.exports = router;
      
