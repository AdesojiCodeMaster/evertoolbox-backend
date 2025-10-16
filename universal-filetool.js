// ===============================
//  EverToolbox Universal File Tool
// ===============================

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs-extra");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

// Ensure folders exist
fs.ensureDirSync("uploads");
fs.ensureDirSync("outputs");

// Helper: Generate a safe output path
function outputPath(file, targetFormat) {
  const name = path.parse(file.originalname).name;
  return path.join("outputs", `${name}-${Date.now()}.${targetFormat}`);
}

// Helper: Clean temporary files
async function cleanup(...files) {
  for (const f of files) {
    try { await fs.remove(f); } catch {}
  }
}

// -------------------------------
//     CORE CONVERSION HANDLERS
// -------------------------------
async function convertFile(file, targetFormat) {
  const inputPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const outputFile = outputPath(file, targetFormat);

  // IMAGE CONVERSION
  const imageExts = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
  if (imageExts.includes(ext)) {
    await sharp(inputPath).toFormat(targetFormat).toFile(outputFile);
    return outputFile;
  }

  // AUDIO CONVERSION
  const audioExts = ["mp3", "wav", "m4a", "ogg", "flac"];
  if (audioExts.includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .toFormat(targetFormat)
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile);
    });
    return outputFile;
  }

  // VIDEO CONVERSION
  const videoExts = ["mp4", "mov", "mkv", "avi", "webm"];
  if (videoExts.includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec("libx264")
        .toFormat(targetFormat)
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile);
    });
    return outputFile;
  }

  // DOCUMENT → PDF or TXT
  const docExts = ["pdf", "txt", "docx", "rtf", "html"];
  if (docExts.includes(ext)) {
    if (targetFormat === "pdf") {
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(outputFile));
      const text = await fs.readFile(inputPath, "utf8").catch(() => "");
      doc.text(text || "Converted document");
      doc.end();
      return outputFile;
    } else if (targetFormat === "txt") {
      const data = await fs.readFile(inputPath, "utf8").catch(() => "");
      await fs.writeFile(outputFile, data);
      return outputFile;
    }
  }

  throw new Error(`Unsupported conversion: ${ext} → ${targetFormat}`);
}

// -------------------------------
//     COMPRESSION HANDLERS
// -------------------------------
async function compressFile(file) {
  const inputPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const outputFile = outputPath(file, ext);

  // IMAGE COMPRESSION
  const imageExts = ["jpg", "jpeg", "png", "webp"];
  if (imageExts.includes(ext)) {
    await sharp(inputPath).jpeg({ quality: 60 }).toFile(outputFile);
    return outputFile;
  }

  // AUDIO COMPRESSION
  const audioExts = ["mp3", "wav", "ogg", "m4a"];
  if (audioExts.includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioBitrate("128k")
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile);
    });
    return outputFile;
  }

  // VIDEO COMPRESSION
  const videoExts = ["mp4", "mov", "mkv", "avi", "webm"];
  if (videoExts.includes(ext)) {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoBitrate("1000k")
        .size("?x720")
        .on("end", resolve)
        .on("error", reject)
        .save(outputFile);
    });
    return outputFile;
  }

  throw new Error(`Unsupported compression for format: ${ext}`);
}

// -------------------------------
//     PDF THUMBNAIL GENERATION
// -------------------------------
async function generatePdfThumbnail(pdfPath) {
  const thumbnail = pdfPath.replace(/\.pdf$/i, "-thumb.jpg");
  const exists = await fs.pathExists(pdfPath);
  if (!exists) return null;
  try {
    // Generate placeholder thumbnail (since Render lacks poppler/gs)
    await sharp({
      create: {
        width: 400,
        height: 500,
        channels: 3,
        background: "#f0f0f0",
      },
    })
      .composite([{ input: Buffer.from("PDF", "utf8"), top: 240, left: 180 }])
      .jpeg({ quality: 80 })
      .toFile(thumbnail);
    return thumbnail;
  } catch {
    return null;
  }
}

// -------------------------------
//     MAIN API ENDPOINT
// -------------------------------
app.post("/api/tools/file", upload.single("file"), async (req, res) => {
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

    // Stream file back to client
    res.download(outputFile, path.basename(outputFile), async (err) => {
      if (err) console.error("Download error:", err);
      await cleanup(file.path, outputFile);
    });
  } catch (err) {
    console.error("❌ Processing error:", err.message);
    res.status(500).send(`Processing failed: ${err.message}`);
    await cleanup(file.path);
  }
});

// Health check
app.get("/", (req, res) => res.send("✅ EverToolbox File Tool API running."));

// -------------------------------
//     START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
