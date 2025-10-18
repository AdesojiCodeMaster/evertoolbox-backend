// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PDFDocument } = require("pdf-lib");
const { exec } = require("child_process");
const util = require("util");
const archiver = require("archiver");
const mammoth = require("mammoth");









const router = express.Router();
const upload = multer({ dest: "uploads/" });

const processedDir = path.join(__dirname, "processed");
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

function safeUnlink(f) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

router.post("/api/tools/file", upload.single("file"), async (req, res) => {
  const { mode, targetFormat } = req.body;
  const inputPath = req.file.path;
  const fileName = req.file.originalname;
  const ext = path.extname(fileName).replace(".", "").toLowerCase();
  const outFile = path.join(processedDir, `result_${Date.now()}.${targetFormat || ext}`);

  try {
    // ======== COMPRESS MODE ========
    if (mode === "compress") {
      const zipPath = outFile.replace(/\.\w+$/, ".zip");
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip");
      archive.pipe(output);
      archive.file(inputPath, { name: fileName });
      await archive.finalize();

      return res.download(zipPath, () => {
        safeUnlink(inputPath);
        setTimeout(() => safeUnlink(zipPath), 10000);
      });
    }

    // ======== CONVERT MODE ========
    let content = "";
    if (ext === "txt" && targetFormat === "pdf") {
      // text → pdf (simple fake)
      content = fs.readFileSync(inputPath, "utf8");
      fs.writeFileSync(outFile, `PDF version (simulated)\n\n${content}`);
    } else if (ext === "pdf" && ["png", "jpg", "webp", "gif"].includes(targetFormat)) {
      fs.writeFileSync(outFile, `Simulated image of PDF (${targetFormat.toUpperCase()})`);
    } else if (["jpg", "png", "jpeg", "webp"].includes(ext) && targetFormat === "pdf") {
      fs.writeFileSync(outFile, `Simulated PDF made from image`);
    } else if (ext === "docx") {
      const fakeText = fs.readFileSync(inputPath).toString("base64").slice(0, 200);
      if (targetFormat === "txt") fs.writeFileSync(outFile, "DOCX text (simulated)\n" + fakeText);
      else if (targetFormat === "pdf") fs.writeFileSync(outFile, "Simulated PDF from DOCX");
      else if (targetFormat === "html") fs.writeFileSync(outFile, "<html><body><h3>Simulated HTML from DOCX</h3></body></html>");
    } else if (["mp4", "mov", "avi", "mp3", "wav"].includes(ext)) {
      fs.writeFileSync(outFile, `Simulated conversion of ${ext} → ${targetFormat}`);
    } else {
      // Fallback: simple rename to simulate conversion
      fs.copyFileSync(inputPath, outFile);
    }

    res.download(outFile, err => {
      safeUnlink(inputPath);
      setTimeout(() => safeUnlink(outFile), 10000);
      if (err) console.error("Send error:", err);
    });
  } catch (err) {
    console.error("Conversion failed:", err);
    res.status(500).send("Conversion failed.");
  }
});

module.exports = router;
  
