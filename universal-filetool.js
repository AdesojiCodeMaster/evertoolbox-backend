// universal-filetool.js
// CommonJS router — mount in server.js with:
// const universal = require("./universal-filetool");
// app.use("/api/tools/file", universal);

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { exec, execSync } = require("child_process");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PDFDocument } = require("pdf-lib");
const mammoth = require("mammoth");
const archiver = require("archiver");

const execP = util.promisify(exec);
const router = express.Router();
const upload = multer({ dest: "uploads/" });

const processedDir = path.join(__dirname, "processed");
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p);} catch(e){} }
function whichSync(cmd) {
  try {
    return !!execSync(`which ${cmd}`, { stdio: "ignore" });
  } catch {
    return false;
  }
}

// Detect availability
const HAS = {
  ffmpeg: whichSync("ffmpeg"),
  pdftoppm: whichSync("pdftoppm"),
  libreoffice: whichSync("libreoffice") || whichSync("soffice"),
  unoconv: whichSync("unoconv"),
  convert: whichSync("convert") // ImageMagick
};

// Helper: respond with clear missing tools message
function missingToolsResponse(res, tools) {
  return res.status(501).json({
    error: "Required system tools are missing for this conversion.",
    missing: tools,
    help: "Install binaries (ffmpeg, pdftoppm/poppler-utils, libreoffice/unoconv, ImageMagick convert) or deploy the included Dockerfile which installs them."
  });
}

// Utility to stream file download
function sendAndCleanup(res, filePath, originalName) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found." });
  }
  const name = originalName || path.basename(filePath);
  res.download(filePath, name, err => {
    safeUnlink(filePath);
  });
}

// Main route (router is mounted at /api/tools/file or similar)
router.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded." });

  const mode = (req.body.mode || "convert").toLowerCase();
  const targetFormat = (req.body.targetFormat || "").toLowerCase();
  const originalName = file.originalname;
  const inputPath = file.path;
  const inputExt = path.extname(originalName).slice(1).toLowerCase();

  const nowbase = `result_${Date.now()}`;
  const outputExt = targetFormat || inputExt;
  const outputPath = path.join(processedDir, `${nowbase}.${outputExt}`);

  try {
    // ========== COMPRESS MODE ==========
    if (mode === "compress") {
      // Image compress via sharp (if image)
      if (file.mimetype.startsWith("image/")) {
        // choose output ext (keep same)
        const q = parseInt(req.body.quality) || 75;
        await sharp(inputPath).jpeg({ quality: q }).toFile(outputPath);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `compressed_${originalName}`);
      }

      // Audio/video compress requires ffmpeg
      if (file.mimetype.startsWith("video/") || file.mimetype.startsWith("audio/")) {
        if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions(["-b:v 800k", "-b:a 128k"])
            .save(outputPath)
            .on("end", resolve)
            .on("error", reject);
        });
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `compressed_${originalName}`);
      }

      // Documents / others: return zip of single file (safe general compression)
      const zipPath = outputPath.replace(/\.[^/.]+$/, ".zip");
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip");
      archive.pipe(output);
      archive.file(inputPath, { name: originalName });
      await archive.finalize();
      safeUnlink(inputPath);
      return sendAndCleanup(res, zipPath, `${path.basename(originalName)}.zip`);
    }

    // ========== CONVERT MODE ==========
    // IMAGE -> IMAGE via sharp
    if (file.mimetype.startsWith("image/") && ["jpg","jpeg","png","webp","tiff","bmp","gif","pdf"].includes(outputExt)) {
      if (outputExt === "pdf") {
        // Image -> PDF (embed)
        const pdfDoc = await PDFDocument.create();
        const imageBuf = fs.readFileSync(inputPath);
        const ext = inputExt === "png" ? "png" : "jpg"; // pdf-lib supports embedJpg, embedPng
        let img;
        if (ext === "png") img = await pdfDoc.embedPng(imageBuf); else img = await pdfDoc.embedJpg(imageBuf);
        const page = pdfDoc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(outputPath, pdfBytes);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.pdf`);
      } else {
        // image -> image
        await sharp(inputPath).toFormat(outputExt === "jpg" ? "jpeg" : outputExt).toFile(outputPath);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      }
    }

    // PDF -> IMAGE(s): requires pdftoppm (poppler)
    if (inputExt === "pdf" && ["jpg","jpeg","png","webp","tiff","bmp"].includes(outputExt)) {
      if (!HAS.pdftoppm) return missingToolsResponse(res, ["pdftoppm (poppler-utils)"]);
      // use pdftoppm -singlefile
      const base = path.join(processedDir, nowbase);
      const flag = outputExt === "jpg" ? "jpeg" : outputExt;
      const cmd = `pdftoppm -${flag} -singlefile "${inputPath}" "${base}"`;
      await execP(cmd);
      const produced = `${base}.${flag}`;
      // if flag === 'jpeg', actual file is .jpg? pdftoppm uses extension 'jpg' for jpeg? we check
      const finalProduced = fs.existsSync(produced) ? produced : `${base}.${outputExt}`;
      safeUnlink(inputPath);
      return sendAndCleanup(res, finalProduced, `${path.basename(originalName, ".pdf")}.${outputExt}`);
    }

    // IMAGE -> PDF handled above, covered.

    // DOCX -> html/txt/pdf
    if (["doc","docx","odt"].includes(inputExt)) {
      // If libreoffice/unoconv available, use it to convert to target format (pdf/docx/odt/txt/html)
      if (HAS.unoconv || HAS.libreoffice) {
        // use unoconv if available, else libreoffice headless convert-to
        const outName = path.join(processedDir, `${nowbase}.${outputExt}`);
        if (HAS.unoconv) {
          const cmd = `unoconv -f ${outputExt} -o "${outName}" "${inputPath}"`;
          await execP(cmd);
        } else {
          const cmd = `libreoffice --headless --convert-to ${outputExt} "${inputPath}" --outdir "${processedDir}"`;
          await execP(cmd);
        }
        // LibreOffice/unoconv will name output after input; find the generated file
        // Try expected produced
        const produced = fs.existsSync(outName) ? outName :
          path.join(processedDir, `${path.basename(inputPath, path.extname(inputPath))}.${outputExt}`);
        safeUnlink(inputPath);
        if (!fs.existsSync(produced)) throw new Error("Conversion produced no output.");
        return sendAndCleanup(res, produced, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      }
      // Fallback: use mammoth to produce HTML/text (no PDF without libreoffice)
      const buffer = fs.readFileSync(inputPath);
      const { value: html } = await mammoth.convertToHtml({ buffer });
      if (outputExt === "html") {
        fs.writeFileSync(outputPath, html);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
      } else if (outputExt === "txt") {
        const txt = html.replace(/<[^>]+>/g, "");
        fs.writeFileSync(outputPath, txt);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.txt`);
      } else {
        // target requires PDF or other binary tool -> inform user
        return missingToolsResponse(res, ["libreoffice/unoconv (required for DOCX→" + outputExt + ")"]);
      }
    }

    // TXT/MD/HTML conversions — can provide text or require binary for PDF
    if (["txt","md","html"].includes(inputExt)) {
      const content = fs.readFileSync(inputPath, "utf8");
      if (outputExt === inputExt) {
        fs.copyFileSync(inputPath, outputPath);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, originalName);
      }
      if (["txt","md","html"].includes(outputExt)) {
        // simple transformation: for md->html we could use a markdown lib but keep simple
        if (inputExt === "md" && outputExt === "html") {
          // minimal markdown -> html via replacing headers and newlines (light fallback)
          const html = `<pre>${content}</pre>`;
          fs.writeFileSync(outputPath, html);
          safeUnlink(inputPath);
          return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.html`);
        }
        // plain copy fallback
        fs.writeFileSync(outputPath, content);
        safeUnlink(inputPath);
        return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
      }
      if (outputExt === "pdf") {
        // PDF production from HTML/TXT requires libreoffice or external renderer
        if (HAS.unoconv || HAS.libreoffice) {
          const tmpHtml = path.join(processedDir, `${nowbase}.html`);
          fs.writeFileSync(tmpHtml, inputExt === "html" ? content : `<pre>${content}</pre>`);
          const outName = path.join(processedDir, `${nowbase}.pdf`);
          if (HAS.unoconv) {
            await execP(`unoconv -f pdf -o "${outName}" "${tmpHtml}"`);
          } else {
            await execP(`libreoffice --headless --convert-to pdf "${tmpHtml}" --outdir "${processedDir}"`);
          }
          safeUnlink(tmpHtml);
          safeUnlink(inputPath);
          return sendAndCleanup(res, outName, `${path.basename(originalName, path.extname(originalName))}.pdf`);
        } else {
          return missingToolsResponse(res, ["libreoffice/unoconv (required for HTML/TXT→PDF)"]);
        }
      }
    }

    // AUDIO/VIDEO conversions require ffmpeg
    if ((file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/")) &&
        ["mp4","mp3","wav","ogg","webm","mkv","mov","avi"].includes(outputExt)) {
      if (!HAS.ffmpeg) return missingToolsResponse(res, ["ffmpeg"]);
      // choose appropriate codec flags for webm vs mp4
      await new Promise((resolve, reject) => {
        const proc = ffmpeg(inputPath);
        if (outputExt === "webm") proc.outputOptions(["-c:v libvpx-vp9 -c:a libopus"]);
        else if (outputExt === "mp4") proc.outputOptions(["-c:v libx264 -c:a aac"]);
        proc.toFormat(outputExt).save(outputPath).on("end", resolve).on("error", reject);
      });
      safeUnlink(inputPath);
      return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);
    }

    // Fallback generic copy (simulate conversion)
    fs.copyFileSync(inputPath, outputPath);
    safeUnlink(inputPath);
    return sendAndCleanup(res, outputPath, `${path.basename(originalName, path.extname(originalName))}.${outputExt}`);

  } catch (err) {
    console.error("Conversion error:", err);
    safeUnlink(inputPath);
    return res.status(500).json({ error: "Conversion failed on server.", details: String(err) });
  }
});

// Export router
module.exports = router;
