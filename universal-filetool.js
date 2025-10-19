const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { exec } = require("child_process");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir("uploads");
ensureDir("outputs");

function log(...args) {
  console.log("[EverToolbox]", ...args);
}

function cleanup(files = []) {
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);
}

router.post("/file", upload.single("file"), async (req, res) => {
  try {
    const { mode, targetFormat } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const inputPath = file.path;
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const outputPath = path.join("outputs", `${base}_${Date.now()}.${targetFormat || "zip"}`);

    log(`Incoming ${mode} request for:`, file.originalname);

    if (mode === "compress") {
      // Compress image
      const buffer = await sharp(inputPath).jpeg({ quality: 70 }).toBuffer();
      fs.writeFileSync(outputPath, buffer);
      log("Compression completed:", outputPath);
    }

    else if (mode === "convert") {
      const mime = file.mimetype;

      // Convert images
      if (mime.startsWith("image/")) {
        await sharp(inputPath).toFormat(targetFormat).toFile(outputPath);
        log("Image converted:", outputPath);
      }

      // Convert PDF -> image
      else if (mime === "application/pdf" && ["jpg", "jpeg", "png", "webp"].includes(targetFormat)) {
        const baseOut = path.join("outputs", `${base}_${Date.now()}`);
        const cmd = `pdftoppm -${targetFormat} "${inputPath}" "${baseOut}"`;
        log("Running:", cmd);

        await new Promise((resolve, reject) => {
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        const generated = fs.readdirSync("outputs").find(f => f.startsWith(path.basename(baseOut)));
        if (!generated) throw new Error("Output file not found after PDF conversion");

        fs.renameSync(path.join("outputs", generated), outputPath);
        log("PDF converted:", outputPath);
      }

      // Convert audio/video
      else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        const cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
        log("Running:", cmd);

        await new Promise((resolve, reject) => {
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        if (!fs.existsSync(outputPath)) throw new Error("Output file not found after ffmpeg conversion");
        log("Media converted:", outputPath);
      }

      else {
        throw new Error(`Unsupported conversion type: ${mime} -> ${targetFormat}`);
      }
    }

    else {
      throw new Error("Invalid mode");
    }

    if (!fs.existsSync(outputPath)) throw new Error("Output file not found.");

    // Send file for download
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
