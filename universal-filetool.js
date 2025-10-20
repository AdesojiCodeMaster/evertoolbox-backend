// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const router = express.Router();

const execPromise = util.promisify(exec);
const upload = multer({ dest: "uploads/" });

// ===== Helper for cleanup =====
function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}


router.get("/test", (req, res) => {
  res.json({ message: "Universal FileTool API is live" });
});

// ===== API endpoint =====
router.post("/api/tools/file", upload.single("file"), async (req, res) => {
  const { mode, targetFormat } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "No file uploaded." });
  if (mode !== "convert" && mode !== "compress")
    return res.status(400).json({ error: "Invalid mode or missing format." });

  const inputPath = path.resolve(file.path);
  const ext = path.extname(file.originalname).toLowerCase();
  const base = path.basename(file.originalname, ext);
  const tempDir = path.join("temp", Date.now().toString());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    let outputPath = path.join(tempDir, `${base}.${targetFormat || "zip"}`);

    // ---------- FILE CONVERSION ----------
    if (mode === "convert") {
      if (!targetFormat) throw new Error("Missing target format.");

      // IMAGE → IMAGE
      if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"].includes(ext)) {
        await execPromise(`magick "${inputPath}" "${outputPath}"`);
      }

      // AUDIO → AUDIO
      else if ([".mp3", ".wav", ".ogg", ".aac", ".flac", ".m4a"].includes(ext)) {
        await execPromise(`ffmpeg -y -i "${inputPath}" "${outputPath}"`);
      }

      // VIDEO → VIDEO
      else if ([".mp4", ".avi", ".mov", ".webm", ".mkv"].includes(ext)) {
        await execPromise(`ffmpeg -y -i "${inputPath}" -preset medium -crf 23 "${outputPath}"`);
      }

      // PDF → IMAGE
      else if (ext === ".pdf" && ["jpg", "jpeg", "png", "webp"].includes(targetFormat)) {
        outputPath = path.join(tempDir, `${base}_page1.${targetFormat}`);
        await execPromise(`magick -density 150 "${inputPath}[0]" -quality 90 "${outputPath}"`);
      }

      // DOCUMENT → DOCUMENT
      else if ([".doc", ".docx", ".odt", ".html", ".txt", ".md", ".pdf"].includes(ext)) {
        await execPromise(`libreoffice --headless --convert-to ${targetFormat} "${inputPath}" --outdir "${tempDir}"`);
        const files = fs.readdirSync(tempDir);
        outputPath = path.join(tempDir, files.find(f => f.startsWith(base)));
      }

      else {
        throw new Error("Unsupported conversion type.");
      }

      // Return converted file
      res.download(outputPath, err => cleanup(tempDir));
    }

    // ---------- FILE COMPRESSION ----------
    else if (mode === "compress") {
      outputPath = path.join(tempDir, `${base}-compressed${ext}`);

      if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
        await execPromise(`magick "${inputPath}" -strip -interlace Plane -quality 85 "${outputPath}"`);
      } else if ([".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext)) {
        await execPromise(`ffmpeg -y -i "${inputPath}" -vcodec libx264 -crf 28 "${outputPath}"`);
      } else if ([".mp3", ".wav", ".ogg", ".aac", ".flac"].includes(ext)) {
        await execPromise(`ffmpeg -y -i "${inputPath}" -b:a 128k "${outputPath}"`);
      } else if (ext === ".pdf") {
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`);
      } else {
        throw new Error("Unsupported compression format.");
      }

      res.download(outputPath, err => cleanup(tempDir));
    }
  } catch (err) {
    console.error("Processing error:", err.message);
    res.status(500).json({ error: "File processing failed" });
  } finally {
    fs.unlink(file.path, () => {});
  }
});

module.exports = router;
