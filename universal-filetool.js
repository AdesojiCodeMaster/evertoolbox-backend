// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { exec } = require("child_process");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function cleanup(...files) {
  for (const f of files) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

router.post("/file", upload.single("file"), async (req, res) => {
  const { targetFormat, mode } = req.body;
  const input = req.file.path;
  const inputName = req.file.originalname;
  const inputExt = path.extname(inputName).toLowerCase();
  const baseName = `result_${Date.now()}`;
  const outputFile = `${baseName}.${targetFormat || "bin"}`;
  const output = path.join("processed", outputFile);

  try {
    fs.mkdirSync("processed", { recursive: true });

    // ---------- COMPRESSION ----------
    if (mode === "compress") {
      if (inputExt.match(/\.(jpg|jpeg|png|webp|tiff|bmp|gif)$/)) {
        await sharp(input).jpeg({ quality: 60 }).toFile(output);
      } else if (inputExt.match(/\.(mp4|avi|mov|webm|mkv)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .videoBitrate("800k")
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      } else if (inputExt.match(/\.(mp3|wav|ogg|aac|flac)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .audioBitrate("96k")
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      } else {
        throw new Error("Unsupported file for compression");
      }
    }

    // ---------- CONVERSION ----------
    else if (mode === "convert") {
      // IMAGE → PDF
      if (inputExt.match(/\.(jpg|jpeg|png|webp|bmp|tiff|gif)$/) && targetFormat === "pdf") {
        const img = sharp(input);
        const metadata = await img.metadata();
        const buffer = await img.toBuffer();
        const doc = new PDFDocument({ autoFirstPage: false });
        const outStream = fs.createWriteStream(output);
        doc.pipe(outStream);
        doc.addPage({ size: [metadata.width, metadata.height] });
        doc.image(buffer, 0, 0, { width: metadata.width, height: metadata.height });
        doc.end();
        await new Promise((r) => outStream.on("finish", r));
      }

      // PDF → IMAGE
    // --- PDF -> IMAGE (robust) ---
else if (inputExt === ".pdf" && ["jpg","jpeg","png","webp","gif","tiff","bmp"].includes(targetFormat)) {
  await new Promise((resolve, reject) => {
    try {
      const tempBase = path.join("processed", `tmp_${Date.now()}`); // temp prefix
      // step 1: create PNG from first page of PDF using pdftoppm (always available when poppler-utils is installed)
      const cmd = `pdftoppm -png -singlefile "${input}" "${tempBase}"`;
      exec(cmd, async (err) => {
        if (err) {
          console.error("pdftoppm error:", err);
          return reject(err);
        }

        const tempPng = `${tempBase}.png`; // produced by pdftoppm
        try {
          // step 2: if target is png, just rename
          if (targetFormat === "png") {
            fs.renameSync(tempPng, output);
            return resolve();
          }

          // step 3: use sharp to convert tempPng -> desired format
          try {
            const converter = sharp(tempPng);
            // handle special cases or options per format if desired
            if (targetFormat === "jpg" || targetFormat === "jpeg") {
              await converter.jpeg({ quality: 90 }).toFile(output);
            } else if (targetFormat === "webp") {
              await converter.webp({ quality: 90 }).toFile(output);
            } else if (targetFormat === "gif") {
              // sharp can output GIF for single-frame images (non-animated)
              // if sharp doesn't support GIF in your build, fallback to ImageMagick below
              await converter.gif().toFile(output);
            } else if (targetFormat === "tiff") {
              await converter.tiff().toFile(output);
            } else if (targetFormat === "bmp") {
              await converter.raw().toBuffer().then(buf => {
                // Sharp doesn't have .bmp() method; use toFile with .png then convert or use imagemagick fallback
                // We'll try sharp's toFile with {raw} -> but simpler to use sharp to png then imagemagick convert if necessary.
                // Here try sharp.png() -> then convert with imagemagick if available
                const pngTempForBmp = `${tempBase}_intermediate.png`;
                return converter.png().toFile(pngTempForBmp).then(async () => {
                  // use imagemagick convert if present
                  const convertCmd = `convert "${pngTempForBmp}" "${output}"`;
                  exec(convertCmd, (convErr) => {
                    try { fs.unlinkSync(pngTempForBmp); } catch(_) {}
                    if (convErr) return reject(convErr);
                    resolve();
                  });
                });
              });
              return; // exit early because conversion resolved inside
            } else {
              // fallback - try generic toFormat
              await converter.toFile(output);
            }

            // remove tempPng and resolve
            try { fs.unlinkSync(tempPng); } catch(_) {}
            return resolve();
          } catch (sharpErr) {
            // If sharp failed for the requested format (e.g. GIF not supported), fallback to ImageMagick if installed
            console.warn("sharp conversion failed, trying ImageMagick fallback:", sharpErr);
            const targetExt = targetFormat;
            const convertCmd = `convert "${tempPng}" "${output}"`;
            exec(convertCmd, (convErr) => {
              try { fs.unlinkSync(tempPng); } catch(_) {}
              if (convErr) return reject(convErr);
              return resolve();
            });
          }
        } catch (innerErr) {
          try { fs.unlinkSync(tempPng); } catch(_) {}
          return reject(innerErr);
        }
      });
    } catch (outerErr) {
      return reject(outerErr);
    }
  });
}
  
        

      // IMAGE → IMAGE
      else if (inputExt.match(/\.(jpg|jpeg|png|webp|bmp|tiff|gif)$/)) {
        await sharp(input).toFormat(targetFormat).toFile(output);
      }

      // AUDIO or VIDEO
      else if (inputExt.match(/\.(mp3|wav|ogg|aac|flac|mp4|avi|mov|webm|mkv)$/)) {
        await new Promise((resolve, reject) => {
          ffmpeg(input)
            .toFormat(targetFormat)
            .on("end", resolve)
            .on("error", reject)
            .save(output);
        });
      }

      // DOCUMENTS (unoconv)
      // --- DOCUMENT CONVERSIONS ---
else if ([".pdf", ".docx", ".txt", ".md", ".odt"].includes(inputExt)) {
  // Handle DOCX ↔ PDF via unoconv
  if (
    (inputExt === ".docx" && targetFormat === "pdf") ||
    (inputExt === ".pdf" && targetFormat === "docx") ||
    (inputExt === ".odt" && targetFormat === "pdf") ||
    (inputExt === ".pdf" && targetFormat === "odt")
  ) {
    const cmd = `unoconv -f ${targetFormat} -o "${output}" "${input}"`;
    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("unoconv error:", stderr || err);
          return reject(err);
        }
        resolve();
      });
    });
  }

  // Handle TXT ↔ PDF or MD ↔ PDF with pandoc
  else if (
    ([".txt", ".md"].includes(inputExt) && targetFormat === "pdf") ||
    (inputExt === ".pdf" && ["txt", "md"].includes(targetFormat))
  ) {
    const cmd =
      inputExt === ".pdf"
        ? `pdftotext "${input}" "${output}"`
        : `pandoc "${input}" -o "${output}"`;
    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("pandoc/pdftotext error:", stderr || err);
          return reject(err);
        }
        resolve();
      });
    });
  }

  // Handle TXT ↔ DOCX or MD ↔ DOCX
  else if (
    ([".txt", ".md"].includes(inputExt) && targetFormat === "docx") ||
    (inputExt === ".docx" && ["txt", "md"].includes(targetFormat))
  ) {
    const cmd = `pandoc "${input}" -o "${output}"`;
    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("pandoc error:", stderr || err);
          return reject(err);
        }
        resolve();
      });
    });
  }

  // Fallback if unsupported combination
  else {
    throw new Error(`Unsupported document conversion: ${inputExt} → ${targetFormat}`);
  }
     }
  
 // ---------- SUCCESS ----------
    res.download(output, outputFile, () => cleanup(input, output));
  } catch (err) {
    console.error("❌ Conversion failed:", err);
    cleanup(input, output);
    res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;
