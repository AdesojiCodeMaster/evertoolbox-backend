// filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);

const upload = multer({ dest: "uploads/" });

module.exports = function (app) {
  app.post("/api/tools/file/process", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      const { action, targetFormat, quality } = req.body;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const inputPath = file.path;
      const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
      let outputExt = targetFormat || ext;
      const base = path.basename(file.originalname, path.extname(file.originalname));
      const outPath = path.join("uploads", `${base}.${outputExt}`);

      // ---- IMAGE ----
      if (file.mimetype.startsWith("image/")) {
        let q = Math.min(Math.max(parseInt(quality) || 80, 10), 100);
        const pipeline = sharp(inputPath);
        if (action === "compress" || action === "convert") {
          await pipeline.toFormat(outputExt, { quality: q }).toFile(outPath);
        } else await pipeline.toFile(outPath);
      }

      // ---- TEXT / DOC / PDF ----
      else if (file.mimetype.startsWith("text/") || [".txt", ".md", ".html"].includes(path.extname(file.originalname))) {
        let data = fs.readFileSync(inputPath);
        let buf = zlib.gzipSync(data);
        fs.writeFileSync(outPath.endsWith(".gz") ? outPath : outPath + ".gz", buf);
      }

      // ---- AUDIO / VIDEO ----
      else if (file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/")) {
        await new Promise((resolve, reject) => {
          const cmd = ffmpeg(inputPath)
            .outputOptions([
              "-b:a 96k",
              "-b:v 600k",
              "-vf scale=iw*0.5:-1",
            ])
            .toFormat(outputExt)
            .on("end", resolve)
            .on("error", reject)
            .save(outPath);
        });
      }

      // ---- OTHER / ZIP ----
      else {
        const zip = new AdmZip();
        zip.addLocalFile(inputPath);
        zip.writeZip(outPath.endsWith(".zip") ? outPath : outPath + ".zip");
      }

      const stat = fs.statSync(outPath);
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(outPath)}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", stat.size);
      const read = fs.createReadStream(outPath);
      read.pipe(res);
      read.on("close", () => {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outPath);
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Processing failed", details: err.message });
    }
  });
};
