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

router.post("/process", upload.single("file"), async (req, res) => {
  const { action, targetFormat, quality = 80 } = req.body;
  const input = req.file;
  const filePath = input.path;
  const mime = input.mimetype;
  const originalExt = path.extname(input.originalname).slice(1);

  try {
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

    let outputPath = `${filePath}_output.${targetFormat || originalExt}`;
    let outputMime = mime;

    // ====== IMAGE ======
    if (mime.startsWith("image/")) {
      if (action === "compress") {
        await sharp(filePath)
          .jpeg({ quality: Math.min(+quality, 90) })
          .toFile(outputPath);
      } else if (action === "convert") {
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const { width, height } = await sharp(filePath).metadata();
          doc.addPage({ size: [width, height] });
          const imgBuffer = await sharp(filePath).jpeg({ quality: +quality }).toBuffer();
          doc.image(imgBuffer, 0, 0, { width, height });
          doc.pipe(fs.createWriteStream(outputPath));
          await new Promise((resolve) => doc.on("end", resolve));
          doc.end();
        } else {
          await sharp(filePath).toFormat(targetFormat, { quality: +quality }).toFile(outputPath);
          outputMime = `image/${targetFormat}`;
        }
      }
    }

    // ====== TEXT / DOC ======
    else if (mime.includes("text") || mime.includes("html")) {
      const text = fs.readFileSync(filePath, "utf8");
      if (action === "convert" && targetFormat === "pdf") {
        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(outputPath));
        doc.fontSize(12).text(text);
        doc.end();
      } else {
        fs.writeFileSync(outputPath, text);
      }
      outputMime = targetFormat === "pdf" ? "application/pdf" : "text/plain";
    }

    // ====== AUDIO ======
    else if (mime.startsWith("audio/")) {
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(filePath);
        if (action === "compress") {
          cmd.audioBitrate("96k");
        } else if (action === "convert") {
          cmd.toFormat(targetFormat);
        }
        cmd.on("end", resolve)
           .on("error", reject)
           .save(outputPath);
      });
      outputMime = "audio/" + (targetFormat || originalExt);
    }

    // ====== VIDEO ======
    else if (mime.startsWith("video/")) {
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(filePath);
        if (action === "compress") {
          cmd.videoCodec("libx264")
             .outputOptions(["-preset fast", "-crf 28"]);
        } else if (action === "convert") {
          cmd.toFormat(targetFormat);
        }
        cmd.on("end", resolve)
           .on("error", reject)
           .save(outputPath);
      });
      outputMime = "video/" + (targetFormat || originalExt);
    }

    // ====== RETURN FILE ======
    res.setHeader("Content-Disposition", `attachment; filename=result.${targetFormat || originalExt}`);
    res.setHeader("Content-Type", outputMime);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("close", () => {
      cleanup(filePath);
      cleanup(outputPath);
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Processing failed. " + err.message });
  }
});

module.exports = router;
