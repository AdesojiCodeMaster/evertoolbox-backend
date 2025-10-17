// universal-filetool.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { exec } = require("child_process");





async function processFile(inputPath, targetFormat, mode) {
  const uploadsDir = "uploads";
  const processedDir = "processed";
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

  const input = inputPath;
  const inputExt = path.extname(input).toLowerCase();
  const output = path.join(
    processedDir,
    "result_" + Date.now() + "." + targetFormat
  );

  try {
    // === IMAGE CONVERSIONS ===
    if (
      ["jpg", "jpeg", "png", "webp", "tiff", "bmp", "gif"].includes(
        targetFormat
      )
    ) {
      if (inputExt === ".pdf") {
        // PDF → Image
        await new Promise((resolve, reject) => {
          const formatFlag = targetFormat === "jpg" ? "jpeg" : targetFormat;
          const tempBase = output.replace(/\.[^/.]+$/, "");
          const cmd = `pdftoppm -${["jpeg", "png", "tiff"].includes(formatFlag) ? formatFlag : "png"} -singlefile "${input}" "${tempBase}"`;

          exec(cmd, async (err) => {
            if (err) return reject(err);

            // Convert to WEBP, GIF, or BMP if needed
            try {
              if (["webp", "gif", "bmp"].includes(targetFormat)) {
                const sharp = require("sharp");
                await sharp(`${tempBase}.png`).toFile(output);
                fs.unlinkSync(`${tempBase}.png`);
              } else {
                fs.renameSync(`${tempBase}.${formatFlag}`, output);
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
      } else {
        // Image → Image
        await new Promise((resolve, reject) => {
          const cmd = `convert "${input}" "${output}"`;
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });
      }
    }

    // === IMAGE → PDF ===
    else if (
      [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"].includes(inputExt) &&
      targetFormat === "pdf"
    ) {
      await new Promise((resolve, reject) => {
        const cmd = `convert "${input}" "${output}"`;
        exec(cmd, (err) => (err ? reject(err) : resolve()));
      });
    }

    // === AUDIO CONVERSIONS ===
    else if (
      [".mp3", ".wav", ".ogg", ".aac", ".flac"].includes(inputExt) &&
      ["mp3", "wav", "ogg", "aac", "flac"].includes(targetFormat)
    ) {
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i "${input}" "${output}"`;
        exec(cmd, (err) => (err ? reject(err) : resolve()));
      });
    }

    // === VIDEO CONVERSIONS ===
    else if (
      [".mp4", ".avi", ".mov", ".webm", ".mkv"].includes(inputExt) &&
      ["mp4", "avi", "mov", "webm", "mkv"].includes(targetFormat)
    ) {
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i "${input}" -preset medium -crf 23 "${output}"`;
        exec(cmd, (err) => (err ? reject(err) : resolve()));
      });
    }

    // === DOCUMENT CONVERSIONS ===
    else if ([".pdf", ".docx", ".txt", ".md", ".odt"].includes(inputExt)) {
      // DOCX ↔ PDF, ODT ↔ PDF
      if (
        (inputExt === ".docx" && targetFormat === "pdf") ||
        (inputExt === ".pdf" && targetFormat === "docx") ||
        (inputExt === ".odt" && targetFormat === "pdf") ||
        (inputExt === ".pdf" && targetFormat === "odt")
      ) {
        await new Promise((resolve, reject) => {
          const cmd = `unoconv -f ${targetFormat} -o "${output}" "${input}"`;
          exec(cmd, (err, stdout, stderr) => {
            if (err) {
              console.error("unoconv error:", stderr || err);
              return reject(err);
            }
            resolve();
          });
        });
      }

      // TXT/MD ↔ PDF
      else if (
        ([".txt", ".md"].includes(inputExt) && targetFormat === "pdf") ||
        (inputExt === ".pdf" && ["txt", "md"].includes(targetFormat))
      ) {
        await new Promise((resolve, reject) => {
          const cmd =
            inputExt === ".pdf"
              ? `pdftotext "${input}" "${output}"`
              : `pandoc "${input}" -o "${output}"`;
          exec(cmd, (err, stdout, stderr) => {
            if (err) {
              console.error("pandoc/pdftotext error:", stderr || err);
              return reject(err);
            }
            resolve();
          });
        });
      }

      // TXT/MD ↔ DOCX
      else if (
        ([".txt", ".md"].includes(inputExt) && targetFormat === "docx") ||
        (inputExt === ".docx" && ["txt", "md"].includes(targetFormat))
      ) {
        await new Promise((resolve, reject) => {
          const cmd = `pandoc "${input}" -o "${output}"`;
          exec(cmd, (err, stdout, stderr) => {
            if (err) {
              console.error("pandoc error:", stderr || err);
              return reject(err);
            }
            resolve();
          });
        });
      } else {
        throw new Error(
          `Unsupported document conversion: ${inputExt} → ${targetFormat}`
        );
      }
    }

    // === COMPRESSION MODE ===
    else if (mode === "compress") {
      const cmd = `ffmpeg -y -i "${input}" -b:v 1M "${output}"`;
      await new Promise((resolve, reject) => {
        exec(cmd, (err) => (err ? reject(err) : resolve()));
      });
    }

    // === UNSUPPORTED COMBINATION ===
    else {
      throw new Error(`Unsupported file type: ${inputExt} → ${targetFormat}`);
    }

    return output;
  } catch (err) {
    console.error("❌ Conversion failed:", err);
    throw err;
  }
}

module.exports = processFile;
                            
