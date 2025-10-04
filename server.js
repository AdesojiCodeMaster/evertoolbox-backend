const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { exec } = require("child_process");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "converters/" });

app.use(cors());
app.use(express.json());

/**
 * ✅ PDF/DOCX Conversion (LibreOffice)
 */
app.post("/api/convert-doc", upload.single("file"), (req, res) => {
  const file = req.file;
  const outputPath = `${file.path}.pdf`;

  exec(`libreoffice --headless --convert-to pdf --outdir converters ${file.path}`, (err) => {
    if (err) return res.status(500).json({ error: "Conversion failed" });

    const outFile = file.originalname.replace(/\.[^/.]+$/, ".pdf");
    res.download(path.join("converters", outFile), () => {
      fs.unlinkSync(file.path);
      fs.unlinkSync(path.join("converters", outFile));
    });
  });
});

/**
 * ✅ Image Conversion (JPG, PNG, WEBP, etc.)
 */
app.post("/api/convert-img", upload.single("file"), async (req, res) => {
  const { format } = req.body; // e.g., "png", "webp"
  const outputPath = `${req.file.path}.${format}`;

  try {
    await sharp(req.file.path).toFormat(format).toFile(outputPath);

    res.download(outputPath, () => {
      fs.unlinkSync(req.file.path);
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    res.status(500).json({ error: "Image conversion failed" });
  }
});

/**
 * ✅ TTS Placeholder (Server integration possible later)
 */
app.post("/api/tts", (req, res) => {
  const { text, lang } = req.body;

  // For now, just send text back (we can integrate Google Cloud or AWS Polly later)
  res.json({ message: `TTS request received for [${lang}]: ${text}` });
});

/**
 * Root
 */
app.get("/", (req, res) => {
  res.send("EverToolbox Backend is running ✅");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
        
