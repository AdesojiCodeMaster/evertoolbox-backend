const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// helper to clean temp files
function cleanup(file) {
  if (fs.existsSync(file)) fs.unlink(file, () => {});
}

// extend ffmpeg timeout
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg"); // Render’s ffmpeg path (usually available)

router.post("/process", upload.single("file"), async (req, res) => {
  const { action, targetFormat, quality = 80 } = req.body;
  const input = req.file;
  const filePath = input.path;
  const mime = input.mimetype;
  const originalExt = path.extname(input.originalname).slice(1);

  try {
    if (!action) return res.status(400).json({ error: "Please select an action." });
    if (action === "convert" && !targetFormat)
      return res.status(400).json({ error: "Please select a target format." });
    if (action === "convert" && targetFormat === originalExt)
      return res.status(400).json({ error: "Source and target formats are the same." });

    const outputExt = targetFormat || originalExt;
    const outputPath = `${filePath}_out.${outputExt}`;
    let outputMime = mime;

    // ========== IMAGE ==========
    if (mime.startsWith("image/")) {
      if (action === "compress") {
        await sharp(filePath)
          .jpeg({ quality: Math.min(+quality, 90) })
          .toFile(outputPath);
      } else {
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const { width, height } = await sharp(filePath).metadata();
          doc.addPage({ size: [width, height] });
          const buf = await sharp(filePath).jpeg({ quality: +quality }).toBuffer();
          doc.image(buf, 0, 0, { width, height });
          doc.pipe(fs.createWriteStream(outputPath));
          doc.end();
        } else {
          await sharp(filePath).toFormat(targetFormat, { quality: +quality }).toFile(outputPath);
        }
      }
      outputMime = targetFormat === "pdf" ? "application/pdf" : "image/" + outputExt;
    }

    // ========== TEXT/DOC ==========
    else if (mime.includes("text") || mime.includes("html")) {
      const text = fs.readFileSync(filePath, "utf8");
      if (targetFormat === "pdf") {
        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(outputPath));
        doc.fontSize(12).text(text);
        doc.end();
        outputMime = "application/pdf";
      } else {
        fs.writeFileSync(outputPath, text);
        outputMime = "text/plain";
      }
    }

    // ========== AUDIO ==========
    else if (mime.startsWith("audio/")) {
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(filePath)
          .audioCodec("libmp3lame")
          .audioBitrate(action === "compress" ? "96k" : "192k")
          .on("end", resolve)
          .on("error", reject);
        if (action === "convert") cmd.toFormat(targetFormat);
        cmd.save(outputPath);
      });
      outputMime = "audio/" + outputExt;
    }

    // ========== VIDEO ==========
    else if (mime.startsWith("video/")) {
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(filePath)
          .videoCodec("libx264")
          .audioCodec("aac")
          .outputOptions(action === "compress" ? ["-preset veryfast", "-crf 28"] : [])
          .on("end", resolve)
          .on("error", reject);
        if (action === "convert") cmd.toFormat(targetFormat);
        cmd.save(outputPath);
      });
      outputMime = "video/" + outputExt;
    }

    // send file back
    res.setHeader("Content-Disposition", `attachment; filename=result.${outputExt}`);
    res.setHeader("Content-Type", outputMime);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("close", () => {
      cleanup(filePath);
      cleanup(outputPath);
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Processing failed: " + err.message });
  }
});

module.exports = router;
