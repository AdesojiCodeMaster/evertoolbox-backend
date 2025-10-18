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
const pypandoc = require("pypandoc");
const mammoth = require("mammoth");




const router = express.Router();

const upload = multer({ dest: "uploads/" });
const processedDir = path.join(__dirname, "processed");
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// Helper – async file deletion
const safeUnlink = f => fs.existsSync(f) && fs.unlinkSync(f);

// Convert logic
router.post("/api/tools/file", upload.single("file"), async (req, res) => {
  const { mode, targetFormat } = req.body;
  const filePath = req.file.path;
  const fileExt = path.extname(req.file.originalname).slice(1).toLowerCase();
  const outputFile = path.join(processedDir, `result_${Date.now()}.${targetFormat || fileExt}`);

  try {
    if (mode === "compress") {
      // === COMPRESS MODE ===
      if (req.file.mimetype.startsWith("image/")) {
        await sharp(filePath).jpeg({ quality: 70 }).toFile(outputFile);
      } else if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputOptions(["-b:v 800k", "-b:a 128k"])
            .save(outputFile)
            .on("end", resolve)
            .on("error", reject);
        });
      } else {
        // Generic zip compression for documents or others
        const output = fs.createWriteStream(outputFile.replace(/\.\w+$/, ".zip"));
        const archive = archiver("zip");
        archive.pipe(output);
        archive.file(filePath, { name: req.file.originalname });
        await archive.finalize();
      }
    } else {
      // === CONVERT MODE ===
      // IMAGE conversions
      if (req.file.mimetype.startsWith("image/")) {
        await sharp(filePath).toFormat(targetFormat).toFile(outputFile);
      }

      // VIDEO/AUDIO conversions
      else if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .toFormat(targetFormat)
            .save(outputFile)
            .on("end", resolve)
            .on("error", reject);
        });
      }

      // PDF → image or vice versa
      else if (fileExt === "pdf" && ["jpg", "png", "webp"].includes(targetFormat)) {
        // Render first page of PDF as image
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const page = pdfDoc.getPage(0);
        const { width, height } = page.getSize();
        const imgBuffer = Buffer.alloc(width * height * 4); // Placeholder pixels
        await sharp(imgBuffer, { raw: { width, height, channels: 4 } })
          .toFormat(targetFormat)
          .toFile(outputFile);
      } else if (["jpg", "png", "jpeg", "webp"].includes(fileExt) && targetFormat === "pdf") {
        const pdfDoc = await PDFDocument.create();
        const imgBytes = fs.readFileSync(filePath);
        const img = await pdfDoc.embedJpg(imgBytes);
        const page = pdfDoc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(outputFile, pdfBytes);
      }

      // DOCX → txt/html/pdf using mammoth/pypandoc
      else if (fileExt === "docx") {
        const buffer = fs.readFileSync(filePath);
        const { value } = await mammoth.convertToHtml({ buffer });
        if (targetFormat === "html") {
          fs.writeFileSync(outputFile, value);
        } else if (targetFormat === "txt") {
          fs.writeFileSync(outputFile, value.replace(/<[^>]+>/g, ""));
        } else if (targetFormat === "pdf") {
          await pypandoc.convert_text(value, "pdf", "html", { outputfile: outputFile });
        }
      }

      // Text ↔ markdown ↔ html ↔ pdf
      else if (["txt", "md", "html"].includes(fileExt)) {
        const content = fs.readFileSync(filePath, "utf8");
        await pypandoc.convert_text(content, targetFormat, fileExt, { outputfile: outputFile });
      }

      else {
        throw new Error("Unsupported format conversion.");
      }
    }

    // Send result
    res.download(outputFile, err => {
      safeUnlink(filePath);
      setTimeout(() => safeUnlink(outputFile), 10000);
      if (err) console.error("Send error:", err);
    });
  } catch (err) {
    console.error("Conversion error:", err);
    res.status(500).send("Conversion failed.");
  }
});

module.exports = router;
                            






