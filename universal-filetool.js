// universal-filetool.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import PDFDocument from "pdfkit";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({ dest: "uploads/" });
const cleanup = (p) => fs.existsSync(p) && fs.unlinkSync(p);

app.use(express.static("."));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/process", upload.single("file"), async (req, res) => {
  try {
    const { action, targetFormat, quality = 80 } = req.body;
    const file = req.file;
    const filePath = file.path;
    const mime = file.mimetype;
    const originalExt = path.extname(file.originalname).slice(1);
    let ext = targetFormat || originalExt;
    let filename = `result.${ext}`;
    let outBuffer, outMime = mime;

    if (!action) return res.status(400).json({ error: "Missing action" });

    // 🗜️ Compression
    if (action === "compress") {
      if (mime.startsWith("image/")) {
        outBuffer = await sharp(filePath).jpeg({ quality: +quality }).toBuffer();
        outMime = mime;
      } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        const outExt = mime.startsWith("audio/") ? "mp3" : "mp4";
        const outPath = `${filePath}.${outExt}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputOptions(["-b:v 800k", "-b:a 128k", "-preset superfast"])
            .on("end", resolve)
            .on("error", reject)
            .save(outPath);
        });
        outBuffer = fs.readFileSync(outPath);
        filename = `compressed.${outExt}`;
        outMime = mime.startsWith("audio/") ? `audio/${outExt}` : `video/${outExt}`;
        cleanup(outPath);
      } else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    // 🔄 Conversion
    else if (action === "convert") {
      if (mime.startsWith("image/")) {
        if (targetFormat === "pdf") {
          const doc = new PDFDocument({ autoFirstPage: false });
          const chunks = [];
          doc.on("data", (d) => chunks.push(d));
          doc.on("end", () => {
            const buffer = Buffer.concat(chunks);
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Type", "application/pdf");
            res.end(buffer, () => cleanup(filePath));
          });
          const image = sharp(filePath);
          const { width, height } = await image.metadata();
          doc.addPage({ size: [width, height] });
          const imgBuf = await image.jpeg({ quality: 90 }).toBuffer();
          doc.image(imgBuf, 0, 0, { width, height });
          doc.end();
          return;
        } else {
          outBuffer = await sharp(filePath).toFormat(targetFormat, { quality: +quality }).toBuffer();
          outMime = `image/${targetFormat}`;
        }
      } else if (mime === "application/pdf") {
        const pdfData = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfData);
        if (["txt", "html"].includes(targetFormat)) {
          const text = pdfDoc.getPageIndices().map(i => `Page ${i+1}`).join("\n\n");
          outBuffer = Buffer.from(text, "utf8");
          outMime = targetFormat === "txt" ? "text/plain" : "text/html";
        } else if (["png", "jpg", "jpeg", "webp"].includes(targetFormat)) {
          const tmpOut = `${filePath}.${targetFormat}`;
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .outputOptions(["-frames:v 1"])
              .output(tmpOut)
              .on("end", resolve)
              .on("error", reject)
              .run();
          });
          outBuffer = fs.readFileSync(tmpOut);
          outMime = `image/${targetFormat}`;
          cleanup(tmpOut);
        } else throw new Error("Unsupported PDF conversion target.");
      } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        const outPath = `${filePath}.${targetFormat}`;
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputOptions(["-preset superfast"])
            .output(outPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
        });
        outBuffer = fs.readFileSync(outPath);
        outMime = mime.startsWith("audio/") ? `audio/${targetFormat}` : `video/${targetFormat}`;
        cleanup(outPath);
      } else {
        outBuffer = fs.readFileSync(filePath);
      }
    }

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", outMime);
    res.end(outBuffer, () => cleanup(filePath));
  } catch (e) {
    console.error("❌ Processing failed:", e);
    res.status(500).json({ error: "Processing failed: " + e.message });
  }
});

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
  
