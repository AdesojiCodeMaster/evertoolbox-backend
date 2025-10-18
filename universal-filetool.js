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





async function processFile(file, targetFormat, mode) {
  try {
    // ✅ Handle both file object and direct path
    const inputPath =
      typeof file === "string" ? file : file?.path || file?.file?.path;

    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error("Invalid file path or missing uploaded file");
    }

    const inputExt = path.extname(inputPath).toLowerCase();
    const baseName = path.basename(inputPath, inputExt);
    const outputBase = `processed/result_${Date.now()}`;
    let outputPath = "";

    // ✅ Ensure processed directory exists
    if (!fs.existsSync("processed")) fs.mkdirSync("processed", { recursive: true });

    console.log(`🔧 Processing: ${inputPath} → ${targetFormat} [mode: ${mode}]`);

    // ========== CONVERSION MODE ==========
    if (mode === "convert") {
      // ===== IMAGES & PDF =====
      if (inputExt === ".pdf") {
        const imgFormats = ["jpg", "jpeg", "png", "webp", "tiff", "bmp"];
        if (imgFormats.includes(targetFormat)) {
          await execPromise(
            `pdftoppm -${targetFormat} -singlefile "${inputPath}" "${outputBase}"`
          );
          outputPath = `${outputBase}.${targetFormat}`;
        } else if (targetFormat === "txt") {
          await execPromise(`pdftotext "${inputPath}" "${outputBase}.txt"`);
          outputPath = `${outputBase}.txt`;
        } else {
          throw new Error(`Unsupported PDF output format: ${targetFormat}`);
        }
      } else if ([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"].includes(inputExt)) {
        if (targetFormat === "pdf") {
          await execPromise(`convert "${inputPath}" "${outputBase}.pdf"`);
          outputPath = `${outputBase}.pdf`;
        } else {
          await execPromise(`convert "${inputPath}" "${outputBase}.${targetFormat}"`);
          outputPath = `${outputBase}.${targetFormat}`;
        }
      }

      // ===== DOCUMENTS =====
      else if ([".pdf", ".docx", ".html", ".md", ".txt"].includes(inputExt)) {
        await execPromise(
          `unoconv -f ${targetFormat} -o "${outputBase}.${targetFormat}" "${inputPath}"`
        );
        outputPath = `${outputBase}.${targetFormat}`;
      }

      // ===== AUDIO =====
      else if ([".mp3", ".wav", ".ogg", ".aac", ".flac"].includes(inputExt)) {
        await execPromise(
          `ffmpeg -y -i "${inputPath}" "${outputBase}.${targetFormat}"`
        );
        outputPath = `${outputBase}.${targetFormat}`;
      }

      // ===== VIDEO =====
      else if ([".mp4", ".avi", ".mov", ".webm", ".mkv"].includes(inputExt)) {
        await execPromise(
          `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -c:a aac "${outputBase}.${targetFormat}"`
        );
        outputPath = `${outputBase}.${targetFormat}`;
      }

      else {
        throw new Error(`Unsupported conversion type: ${inputExt} → ${targetFormat}`);
      }
    }

    // ========== COMPRESSION MODE ==========
    else if (mode === "compress") {
      if ([".jpg", ".jpeg", ".png", ".webp"].includes(inputExt)) {
        await execPromise(
          `convert "${inputPath}" -quality 75 "${outputBase}${inputExt}"`
        );
        outputPath = `${outputBase}${inputExt}`;
      } else if ([".mp3", ".wav", ".ogg", ".aac", ".flac"].includes(inputExt)) {
        await execPromise(
          `ffmpeg -y -i "${inputPath}" -b:a 128k "${outputBase}${inputExt}"`
        );
        outputPath = `${outputBase}${inputExt}`;
      } else if ([".mp4", ".avi", ".mov", ".webm", ".mkv"].includes(inputExt)) {
        await execPromise(
          `ffmpeg -y -i "${inputPath}" -b:v 1000k -b:a 128k "${outputBase}${inputExt}"`
        );
        outputPath = `${outputBase}${inputExt}`;
      } else {
        throw new Error(`Compression not supported for: ${inputExt}`);
      }
    }

    // ✅ Success
    console.log(`✅ File processed successfully: ${outputPath}`);
    return outputPath;

  } catch (err) {
    console.error("❌ Conversion failed:", err);
    throw err;
  }
}

module.exports = { processFile };
            
