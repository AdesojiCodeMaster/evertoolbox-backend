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
        



//FOR SEO ANALYZER 

import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();

app.get("/api/seo-analyze", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const resp = await fetch(url);
    const html = await resp.text();
    const $ = cheerio.load(html);

    const title = $("title").text() || "";
    const description = $('meta[name="description"]').attr("content") || "";

    const issues = [];
    if (title.length < 30 || title.length > 65) issues.push("Title length should be 30–65 characters.");
    if (description.length < 70 || description.length > 160) issues.push("Meta description should be 70–160 characters.");

    res.json({ title, description, issues });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch page." });
  }
});

export default app;
  
