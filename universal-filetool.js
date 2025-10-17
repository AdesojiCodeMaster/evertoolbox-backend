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
const upload = multer({ dest: "uploads/" });

function cleanup(...files) {
  for (const f of files) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

router.post("/file", upload.single("file"), async (req, res) => {
  const { targetFormat, mode } = req.body;
  const input = req.file.path;
  const inputName = req.file.originalname;
  const inputExt = path.extname(inputName).toLowerCase();
  const baseName = `result_${Date.now()}`;
  const outputFile = `${baseName}.${targetFormat || "bin"}`;
  const output = path.join("processed", outputFile);

  try {
    fs.mkdirSync("processed", { recursive: true });

    // ---------- COMPRESSION ----------
    if (mode === "compress") {
      if (inputExt.match(/\.(jpg|jpeg|png|webp|tiff|bmp|gif)$/)) {
        await sharp(input).jpeg({ quality: 60 }).toFile(output);
      } else if (inputExt.match(/\.(mp4|avi|mov|webm|mkv)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .videoBitrate("800k")
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      } else if (inputExt.match(/\.(mp3|wav|ogg|aac|flac)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .audioBitrate("96k")
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      } else {
        throw new Error("Unsupported file for compression");
      }
    }

    // ---------- CONVERSION ----------
    else if (mode === "convert") {
      // IMAGE → PDF
      if (inputExt.match(/\.(jpg|jpeg|png|webp|bmp|tiff|gif)$/) && targetFormat === "pdf") {
        const img = sharp(input);
        const metadata = await img.metadata();
        const buffer = await img.toBuffer();
        const doc = new PDFDocument({ autoFirstPage: false });
        const outStream = fs.createWriteStream(output);
        doc.pipe(outStream);
        doc.addPage({ size: [metadata.width, metadata.height] });
        doc.image(buffer, 0, 0, { width: metadata.width, height: metadata.height });
        doc.end();
        await new Promise((r) => outStream.on("finish", r));
      }

      // PDF → IMAGE
    else if (inputExt === ".pdf" && ["jpg", "jpeg", "png", "webp"].includes(targetFormat)) {
    await new Promise((resolve, reject) => {
    const formatFlag = targetFormat === "jpg" ? "jpeg" : targetFormat;
    const cmd = `pdftoppm -${formatFlag} -singlefile "${input}" "${output.replace(/\.[^/.]+$/, '')}"`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
      }
        

      // IMAGE → IMAGE
      else if (inputExt.match(/\.(jpg|jpeg|png|webp|bmp|tiff|gif)$/)) {
        await sharp(input).toFormat(targetFormat).toFile(output);
      }

      // AUDIO or VIDEO
      else if (inputExt.match(/\.(mp3|wav|ogg|aac|flac|mp4|avi|mov|webm|mkv)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .toFormat(targetFormat)
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      }

      // DOCUMENTS (unoconv)
      else if (inputExt.match(/\.(pdf|docx|txt|md|html)$/)) {
        await new Promise((resolve, reject) => {
          exec(`unoconv -f ${targetFormat} -o "${output}" "${input}"`, (err) =>
            err ? reject(err) : resolve()
          );
        });
      }

      else {
        throw new Error("Unsupported file for conversion");
      }
    }

    // ---------- SUCCESS ----------
    res.download(output, outputFile, () => cleanup(input, output));
  } catch (err) {
    console.error("❌ Conversion failed:", err);
    cleanup(input, output);
    res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;
