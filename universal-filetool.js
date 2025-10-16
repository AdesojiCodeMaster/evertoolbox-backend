const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs-extra");
const path = require("path");
const PDFDocument = require("pdfkit");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

fs.ensureDirSync("uploads");
fs.ensureDirSync("outputs");

function outputPath(file, targetFormat) {
  const name = path.parse(file.originalname).name;
  return path.join("outputs", `${name}-${Date.now()}.${targetFormat}`);
}

async function cleanup(...files) {
  for (const f of files) {
    try { await fs.remove(f); } catch {}
  }
}

async function convertFile(file, targetFormat) {
  const inputPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const outputFile = outputPath(file, targetFormat);

  const imageExts = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
  const audioExts = ["mp3", "wav", "m4a", "ogg", "flac"];
  const videoExts = ["mp4", "mov", "mkv", "avi", "webm"];
  const docExts = ["pdf", "txt", "docx", "rtf", "html"];

  if (imageExts.includes(ext)) {
    await sharp(inputPath).toFormat(targetFormat).toFile(outputFile);
  } else if (audioExts.includes(ext)) {
    await new Promise((resolve, reject) =>
      ffmpeg(inputPath).toFormat(targetFormat)
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile)
    );
  } else if (videoExts.includes(ext)) {
    await new Promise((resolve, reject) =>
      ffmpeg(inputPath)
        .videoCodec("libx264")
        .toFormat(targetFormat)
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile)
    );
  } else if (docExts.includes(ext)) {
    if (targetFormat === "pdf") {
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(outputFile));
      const text = await fs.readFile(inputPath, "utf8").catch(() => "");
      doc.text(text || "Converted document");
      doc.end();
    } else if (targetFormat === "txt") {
      const data = await fs.readFile(inputPath, "utf8").catch(() => "");
      await fs.writeFile(outputFile, data);
    } else {
      throw new Error(`Unsupported document conversion: ${ext} → ${targetFormat}`);
    }
  } else {
    throw new Error(`Unsupported conversion: ${ext} → ${targetFormat}`);
  }

  return outputFile;
}

async function compressFile(file) {
  const inputPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const outputFile = outputPath(file, ext);

  const imageExts = ["jpg", "jpeg", "png", "webp"];
  const audioExts = ["mp3", "wav", "ogg", "m4a"];
  const videoExts = ["mp4", "mov", "mkv", "avi", "webm"];

  if (imageExts.includes(ext)) {
    await sharp(inputPath).jpeg({ quality: 60 }).toFile(outputFile);
  } else if (audioExts.includes(ext)) {
    await new Promise((resolve, reject) =>
      ffmpeg(inputPath)
        .audioBitrate("128k")
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile)
    );
  } else if (videoExts.includes(ext)) {
    await new Promise((resolve, reject) =>
      ffmpeg(inputPath)
        .videoBitrate("1000k")
        .size("?x720")
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile)
    );
  } else {
    throw new Error(`Unsupported compression: ${ext}`);
  }

  return outputFile;
}

router.post("/", upload.single("file"), async (req, res) => {
  const { action, targetFormat } = req.body;
  const file = req.file;

  if (!file) return res.status(400).send("No file uploaded.");
  if (action === "convert" && !targetFormat)
    return res.status(400).send("Missing target format.");
  if (action === "convert" && targetFormat === path.extname(file.originalname).slice(1))
    return res.status(400).send("Source and target formats are the same.");

  try {
    let outputFile;
    if (action === "convert") outputFile = await convertFile(file, targetFormat);
    else if (action === "compress") outputFile = await compressFile(file);
    else return res.status(400).send("Invalid action.");

    res.download(outputFile, path.basename(outputFile), async (err) => {
      if (err) console.error("Download error:", err);
      await cleanup(file.path, outputFile);
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).send(`Processing failed: ${err.message}`);
    await cleanup(file.path);
  }
});

module.exports = router;
  
