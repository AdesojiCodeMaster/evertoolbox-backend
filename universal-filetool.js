//universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { exec } = require("child_process");
const PDFDocument = require("pdfkit");

const upload = multer({ dest: "uploads/" });
const router = express.Router();

router.use(upload.single("file"));

router.post("/", async (req, res) => {
  try {
    const file = req.file;
    const mode = req.body.mode;
    const targetFormat = req.body.targetFormat;
    const inputPath = file.path;
    const filename = Date.now() + "." + (targetFormat || file.originalname.split(".").pop());
    const outputPath = path.join("processed", filename);

    if (!fs.existsSync("processed")) fs.mkdirSync("processed");

    if (mode === "convert") {
      await convertFile(inputPath, outputPath, targetFormat);
    } else if (mode === "compress") {
      await compressFile(inputPath, outputPath);
    } else {
      throw new Error("Invalid mode");
    }

    res.download(outputPath, filename, () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  } catch (err) {
    console.error("Conversion error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function convertFile(input, output, target) {
  const ext = target.toLowerCase();

  // Image conversions
  if (["jpg", "jpeg", "png", "webp", "gif", "tiff", "bmp"].includes(ext)) {
    await sharp(input).toFormat(ext).toFile(output);
    return;
  }

  // Audio conversions
  if (["mp3", "wav", "ogg", "aac", "flac"].includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(input).toFormat(ext).on("end", resolve).on("error", reject).save(output);
    });
    return;
  }

  // Video conversions
  if (["mp4", "avi", "mov", "webm", "mkv"].includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(input).toFormat(ext).on("end", resolve).on("error", reject).save(output);
    });
    return;
  }

  // Document conversions
  if (["pdf", "docx", "txt", "md", "html"].includes(ext)) {
    await new Promise((resolve, reject) => {
      exec(`unoconv -f ${ext} -o ${output} ${input}`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    return;
  }

  throw new Error("Unsupported target format: " + ext);
}

async function compressFile(input, output) {
  const ext = path.extname(input).toLowerCase();

  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
    await sharp(input).jpeg({ quality: 60 }).toFile(output);
    return;
  }

  if ([".mp3", ".wav", ".ogg", ".aac", ".flac"].includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(input).audioBitrate("128k").on("end", resolve).on("error", reject).save(output);
    });
    return;
  }

  if ([".mp4", ".avi", ".mov", ".webm", ".mkv"].includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .videoBitrate("1000k")
        .size("?x720")
        .on("end", resolve)
        .on("error", reject)
        .save(output);
    });
    return;
  }

  if ([".pdf", ".docx", ".txt", ".md", ".html"].includes(ext)) {
    fs.copyFileSync(input, output);
    return;
  }

  throw new Error("Unsupported compression format: " + ext);
}

module.exports = router;
