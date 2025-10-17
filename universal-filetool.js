//universal-filetool.js
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function cleanAndSend(res, outputPath, filename) {
  res.download(outputPath, filename, () => {
    fs.unlink(outputPath, () => {});
  });
}

router.post("/", upload.single("file"), async (req, res) => {
  const mode = req.body.mode || "convert";
  const targetFormat = req.body.targetFormat;
  const inputPath = req.file.path;
  const inputExt = path.extname(req.file.originalname).toLowerCase().replace(".", "");
  const outputExt = targetFormat || inputExt;
  const outputDir = "processed";
  const outputPath = path.join(outputDir, `${Date.now()}.${outputExt}`);
  fs.mkdirSync(outputDir, { recursive: true });

  // Supported formats
  const imageFormats = ["jpg", "jpeg", "png", "webp", "gif", "tiff", "bmp"];
  const audioFormats = ["mp3", "wav", "ogg", "aac", "flac"];
  const videoFormats = ["mp4", "avi", "mov", "webm", "mkv"];
  const docFormats = ["pdf", "docx", "txt", "md", "html"];

  try {
    // Conversion
    if (mode === "convert") {
      if (inputExt === outputExt) {
        fs.unlinkSync(inputPath);
        return res.status(400).json({ error: "Source and target formats are the same" });
      }

      // Images
      if (imageFormats.includes(outputExt)) {
        await sharp(inputPath).toFormat(outputExt).toFile(outputPath);
        return cleanAndSend(res, outputPath, `converted.${outputExt}`);
      }

      // Audio
      if (audioFormats.includes(outputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .toFormat(outputExt)
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
        return cleanAndSend(res, outputPath, `converted.${outputExt}`);
      }

      // Video
      if (videoFormats.includes(outputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .toFormat(outputExt)
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
        return cleanAndSend(res, outputPath, `converted.${outputExt}`);
      }

      // Documents
      if (docFormats.includes(outputExt)) {
        await new Promise((resolve, reject) => {
          exec(`unoconv -f ${outputExt} -o ${outputPath} ${inputPath}`, err => {
            if (err) reject(err);
            else resolve();
          });
        });
        return cleanAndSend(res, outputPath, `converted.${outputExt}`);
      }

      return res.status(400).json({ error: "Unsupported target format" });
    }

    // Compression
    if (mode === "compress") {
      // Images
      if (imageFormats.includes(inputExt)) {
        await sharp(inputPath).jpeg({ quality: 65 }).toFile(outputPath);
        return cleanAndSend(res, outputPath, `compressed.${inputExt}`);
      }

      // Audio
      if (audioFormats.includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .audioBitrate("128k")
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
        return cleanAndSend(res, outputPath, `compressed.${inputExt}`);
      }

      // Video
      if (videoFormats.includes(inputExt)) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .videoCodec("libx264")
            .size("1280x720")
            .videoBitrate("1000k")
            .on("end", resolve)
            .on("error", reject)
            .save(outputPath);
        });
        return cleanAndSend(res, outputPath, `compressed.${inputExt}`);
      }

      // Documents
      if (docFormats.includes(inputExt)) {
        const zip = new JSZip();
        zip.file(req.file.originalname, fs.readFileSync(inputPath));
        const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
        fs.writeFileSync(outputPath + ".zip", buffer);
        fs.unlinkSync(inputPath);
        return cleanAndSend(res, outputPath + ".zip", `compressed_${req.file.originalname}.zip`);
      }

      return res.status(400).json({ error: "Unsupported file for compression" });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message || "Processing failed" });
  } finally {
    fs.unlink(inputPath, () => {});
  }
});

module.exports = router;
    
