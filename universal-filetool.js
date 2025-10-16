// universal-filetool.js

// ✅ Import required modules
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const { PDFDocument } = require("pdf-lib");

// ✅ Setup router
const router = express.Router();

// ✅ Setup multer (for handling file uploads)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ✅ Main process route
router.post("/process", upload.single("file"), async (req, res) => {
  try {
    const { action, targetFormat, quality } = req.body;
    const buffer = req.file.buffer;
    const originalName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const ext = path.extname(originalName).toLowerCase();

    // --- Handle image conversions & compression ---
    if (mimeType.startsWith("image/")) {
      const image = sharp(buffer);
      let output;

      if (action === "compress" || action === "convert") {
        const fmt = action === "convert" ? targetFormat : ext.replace(".", "");
        output = await image.toFormat(fmt, { quality: parseInt(quality) || 80 }).toBuffer();

        res.setHeader("Content-Type", `image/${fmt}`);
        return res.send(output);
      }
    }

    // --- Handle PDF compression ---
    if (mimeType === "application/pdf") {
      const pdfDoc = await PDFDocument.load(buffer);
      const newPdf = await pdfDoc.save({ useObjectStreams: false });
      res.setHeader("Content-Type", "application/pdf");
      return res.send(newPdf);
    }

    // --- Handle audio/video conversion (via ffmpeg) ---
    if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
      const tempIn = path.join(__dirname, "input" + ext);
      const outExt = action === "convert" ? targetFormat : ext.replace(".", "");
      const tempOut = path.join(__dirname, "output." + outExt);
      fs.writeFileSync(tempIn, buffer);

      ffmpeg(tempIn)
        .outputOptions(["-q:v 3"])
        .toFormat(outExt)
        .save(tempOut)
        .on("end", () => {
          const data = fs.readFileSync(tempOut);
          fs.unlinkSync(tempIn);
          fs.unlinkSync(tempOut);
          res.setHeader("Content-Type", `${mimeType.startsWith("video/") ? "video" : "audio"}/${outExt}`);
          res.send(data);
        })
        .on("error", (e) => {
          console.error("FFmpeg error:", e);
          res.status(500).send("Processing failed.");
        });
      return;
    }

    // --- Handle unsupported files ---
    res.status(400).send("Unsupported file type.");

  } catch (err) {
    console.error("❌ Processing error:", err);
    res.status(500).send("Processing failed.");
  }
});

// ✅ Export router
module.exports = router;
