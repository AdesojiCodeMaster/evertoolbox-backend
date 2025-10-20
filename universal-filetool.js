// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Helper: remove temp files safely
const safeUnlink = (filePath) => {
  fs.unlink(filePath, (err) => {
    if (err) console.warn(`[WARN] Failed to delete ${filePath}:`, err.message);
  });
};

// POST /api/tools/file
router.post("/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = req.body.mode;
    const targetFormat = req.body.targetFormat || "";
    const inputPath = req.file.path;
    const originalExt = path.extname(req.file.originalname);
    const outputPath = path.join(
      "outputs",
      `${path.basename(req.file.originalname, originalExt)}_${Date.now()}.${targetFormat || "zip"}`
    );

    // Log incoming operation for visibility
    console.log(`[EverToolbox] Mode: ${mode} | Target: ${targetFormat} | File: ${req.file.originalname}`);

    fs.mkdirSync("outputs", { recursive: true });

    let cmd = "";

    if (mode === "convert") {
      // Try ffmpeg or ImageMagick based on file type
      if (req.file.mimetype.startsWith("image/")) {
        cmd = `convert "${inputPath}" "${outputPath}"`;
      } else if (req.file.mimetype.startsWith("video/") || req.file.mimetype.startsWith("audio/")) {
        cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
      } else if (req.file.mimetype === "application/pdf" && targetFormat === "jpg") {
        cmd = `magick convert "${inputPath}" "${outputPath}"`;
      } else {
        return res.status(400).json({ error: "Unsupported conversion type." });
      }
    } else if (mode === "compress") {
      cmd = `zip -j "${outputPath}" "${inputPath}"`;
    } else {
      return res.status(400).json({ error: "Invalid mode." });
    }

    exec(cmd, (err) => {
      safeUnlink(inputPath);

      if (err) {
        console.error("[EverToolbox] Conversion error:", err.message);
        return res.status(500).json({ error: "Processing failed." });
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: "Output file not found." });
      }

      console.log(`[EverToolbox] ✅ Completed: ${outputPath}`);
      res.download(outputPath, path.basename(outputPath), () => safeUnlink(outputPath));
    });
  } catch (error) {
    console.error("[EverToolbox] Internal error:", error);
    res.status(500).json({ error: "Server error occurred." });
  }
});

module.exports = router;
                                                                                 
