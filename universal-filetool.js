// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);





const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Ensure output folder
if (!fs.existsSync("processed")) fs.mkdirSync("processed");

function safeUnlink(file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

router.post("/", upload.single("file"), (req, res) => {
  const { mode, targetFormat } = req.body;
  const file = req.file;
  if (!file) return res.status(400).send("No file uploaded.");

  const inputPath = file.path;
  const inputName = file.originalname;
  const inputExt = path.extname(inputName).slice(1).toLowerCase();
  const outputExt = (targetFormat || inputExt).toLowerCase();
  const baseOut = path.join("processed", `output_${Date.now()}`);
  const outputPath = `${baseOut}.${outputExt}`;

  let cmd = "";

  try {
    // 🔹 COMPRESSION MODE
    if (mode === "compress") {
      if (["jpg", "jpeg", "png", "webp"].includes(inputExt))
        cmd = `convert "${inputPath}" -quality 75 "${outputPath}"`;
      else if (["mp4", "mov", "avi", "mkv", "webm"].includes(inputExt))
        cmd = `ffmpeg -y -i "${inputPath}" -b:v 1M -b:a 128k "${outputPath}"`;
      else if (["mp3", "wav", "ogg", "flac", "aac"].includes(inputExt))
        cmd = `ffmpeg -y -i "${inputPath}" -b:a 128k "${outputPath}"`;
      else if (inputExt === "pdf")
        cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
      else throw new Error("Unsupported compression type");
    }

    // 🔹 CONVERSION MODE
    else {
      // IMAGE ↔ IMAGE
      if (["jpg","jpeg","png","webp","tiff","bmp","gif"].includes(inputExt) &&
          ["jpg","jpeg","png","webp","tiff","bmp","gif","pdf"].includes(outputExt))
        cmd = `convert "${inputPath}" "${outputPath}"`;

      // PDF → IMAGE
      else if (inputExt === "pdf" && ["jpg","jpeg","png","webp","tiff","bmp"].includes(outputExt))
        cmd = `pdftoppm -${outputExt === "jpg" ? "jpeg" : outputExt} -singlefile "${inputPath}" "${baseOut}"`;

      // DOC ↔ PDF ↔ TXT
      else if (["pdf","doc","docx","odt","txt","html","md"].includes(inputExt) &&
               ["pdf","docx","odt","txt","html","md"].includes(outputExt))
        cmd = `libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir processed`;

      // AUDIO ↔ AUDIO
      else if (["mp3","wav","ogg","flac","aac"].includes(inputExt) &&
               ["mp3","wav","ogg","flac","aac"].includes(outputExt))
        cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;

      // VIDEO ↔ VIDEO
      else if (["mp4","mov","avi","mkv","webm"].includes(inputExt) &&
               ["mp4","mov","avi","mkv","webm"].includes(outputExt)) {
        if (outputExt === "webm")
          cmd = `ffmpeg -y -i "${inputPath}" -c:v libvpx-vp9 -b:v 1M -c:a libopus "${outputPath}"`;
        else if (outputExt === "mp4")
          cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -c:a aac "${outputPath}"`;
        else
          cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;
      } else throw new Error("Unsupported conversion type");
    }

    // Execute conversion
    exec(cmd, (err) => {
      safeUnlink(inputPath);
      if (err) {
        console.error("❌ Conversion error:", err);
        return res.status(500).send("Conversion failed.");
      }

      // Handle LibreOffice naming automatically
      if (cmd.includes("libreoffice")) {
        const produced = path.join(
          "processed",
          path.basename(inputName, path.extname(inputName)) + "." + outputExt
        );
        return res.download(produced, () => safeUnlink(produced));
      }

      const out = cmd.includes("pdftoppm") ? `${baseOut}.${outputExt}` : outputPath;
      res.download(out, () => safeUnlink(out));
    });
  } catch (error) {
    console.error(error);
    safeUnlink(inputPath);
    res.status(400).send("Invalid file or parameters.");
  }
});

module.exports = router;
  
