// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { exec } = require("child_process");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Make sure upload/output folders exist
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
ensureDir("uploads");
ensureDir("outputs");

const log = (...msg) => console.log("[EverToolbox]", ...msg);

// Clean up temporary files
function cleanup(paths = []) {
  for (const p of paths) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// MAIN ENDPOINT
router.post("/file", upload.single("file"), async (req, res) => {
  try {
    const { mode, targetFormat } = req.body;
    const inputPath = req.file.path;
    const ext = path.extname(req.file.originalname);
    const base = path.basename(req.file.originalname, ext);
    const outName = `${base}_${Date.now()}.${targetFormat || "zip"}`;
    const outputPath = path.join("outputs", outName);

    log("Request received:", { mode, targetFormat, file: req.file.originalname });

    if (mode === "compress") {
      // compress images only
      const buffer = await sharp(inputPath)
        .jpeg({ quality: 70 })
        .toBuffer();
      fs.writeFileSync(outputPath, buffer);
      log("Compression done:", outputPath);

    } else if (mode === "convert") {
      const mime = req.file.mimetype;

      // Image conversion
      if (mime.startsWith("image/")) {
        await sharp(inputPath).toFormat(targetFormat).toFile(outputPath);
        log("Image converted:", outputPath);

      // PDF → image
      } else if (mime === "application/pdf" && ["jpg", "jpeg", "png", "webp"].includes(targetFormat)) {
        const baseOut = path.join("outputs", `${base}_${Date.now()}`);
        const cmd = `pdftoppm -${targetFormat} "${inputPath}" "${baseOut}"`;
        log("Running:", cmd);

        await new Promise((resolve, reject) => {
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        // Find the first converted page
        const files = fs.readdirSync("outputs").filter(f => f.startsWith(path.basename(baseOut)));
        if (files.length === 0) throw new Error("Output file not found after conversion.");
        const firstOutput = path.join("outputs", files[0]);
        fs.renameSync(firstOutput, outputPath);
        log("PDF converted:", outputPath);

      // Audio/video conversion
      } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        const cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
        log("Running:", cmd);

        await new Promise((resolve, reject) => {
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        if (!fs.existsSync(outputPath)) throw new Error("Output file not found after ffmpeg.");
        log("Media converted:", outputPath);

      } else {
        throw new Error(`Unsupported conversion from ${mime} to ${targetFormat}`);
      }

    } else {
      throw new Error("Invalid mode");
    }

    if (!fs.existsSync(outputPath)) throw new Error("Output file not found.");

    res.download(outputPath, path.basename(outputPath), (err) => {
      cleanup([inputPath, outputPath]);
      if (err) log("Download error:", err.message);
    });

  } catch (err) {
    log("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
