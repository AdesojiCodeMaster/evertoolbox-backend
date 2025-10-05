
// server.js
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";
import unzipper from "unzipper";
import { exec } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: "uploads/" });

// Root route
app.get("/", (req, res) => {
  res.send("✅ EverToolbox Backend is running with all tools!");
});

// =========================
// 1. SEO Analyzer API
// =========================
app.get("/api/seo-analyze", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url query parameter" });

  try {
    const response = await fetch(url, { timeout: 15000 });
    if (!response.ok) return res.status(response.status).json({ error: `Failed to fetch URL: ${response.status}` });

    const html = await response.text();
    const $ = cheerio.load(html);
    const title = $("title").text() || "";
    const description = $('meta[name="description"]').attr("content") || "";
    const issues = [];
    if (title.length < 30 || title.length > 65) issues.push("Title length should be 30–65 characters.");
    if (description.length < 70 || description.length > 160) issues.push("Meta description should be 70–160 characters.");

    res.json({ title, description, issues });
  } catch (err) {
    console.error("SEO Analyzer error:", err);
    res.status(500).json({ error: "Failed to analyze page." });
  }
});

// =========================
// 2. Text-to-Speech (TTS)
// =========================
app.get("/api/tts", async (req, res) => {
  const text = req.query.text || "";
  if (!text.trim()) return res.status(400).json({ error: "Text is required" });

  try {
    // Example: use Google Translate TTS (free endpoint, limited)
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
    const response = await fetch(ttsUrl);
    if (!response.ok) throw new Error("TTS failed");
    res.setHeader("Content-Type", "audio/mpeg");
    response.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Failed to generate TTS" });
  }
});

// =========================
// 3. Document Converter
// =========================
app.post("/api/convert-doc", upload.single("file"), (req, res) => {
  const targetFormat = req.query.format;
  if (!req.file || !targetFormat) return res.status(400).json({ error: "File and format are required" });

  const inputPath = req.file.path;
  const outputPath = `${inputPath}.${targetFormat}`;

  // Use LibreOffice for reliable conversion (Render supports via apt)
  exec(`soffice --headless --convert-to ${targetFormat} --outdir uploads ${inputPath}`, (err) => {
    if (err) {
      console.error("Conversion error:", err);
      return res.status(500).json({ error: "Conversion failed" });
    }
    res.download(outputPath, (err) => {
      if (err) console.error("Download error:", err);
      fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });
  });
});

// =========================
// 4. Image Converter/Editor
// =========================
import sharp from "sharp";

app.post("/api/convert-image", upload.single("file"), async (req, res) => {
  const format = req.query.format || "png";
  const width = parseInt(req.query.width) || null;
  const height = parseInt(req.query.height) || null;
  const grayscale = req.query.grayscale === "true";

  if (!req.file) return res.status(400).json({ error: "Image required" });

  try {
    let img = sharp(req.file.path);
    if (width || height) img = img.resize(width, height);
    if (grayscale) img = img.grayscale();

    const buffer = await img.toFormat(format).toBuffer();
    res.set("Content-Type", `image/${format}`);
    res.send(buffer);
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error("Image conversion error:", err);
    res.status(500).json({ error: "Image conversion failed" });
  }
});

// =========================
// 5. Zip / Unzip
// =========================
app.post("/api/zip", upload.array("files"), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No files provided" });

  const zipPath = path.join("uploads", `archive-${Date.now()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => res.download(zipPath, () => fs.unlinkSync(zipPath)));
  archive.on("error", (err) => res.status(500).json({ error: err.message }));

  archive.pipe(output);
  req.files.forEach((file) => archive.file(file.path, { name: file.originalname }));
  archive.finalize();
});

app.post("/api/unzip", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Zip file required" });

  const extractPath = path.join("uploads", `unzipped-${Date.now()}`);
  fs.mkdirSync(extractPath, { recursive: true });

  fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: extractPath }))
    .on("close", () => {
      res.json({ message: "Unzipped successfully", files: fs.readdirSync(extractPath) });
      fs.unlinkSync(req.file.path);
    });
});

// =========================
// Start server
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 EverToolbox Backend running on port ${PORT}`));

