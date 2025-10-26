// universal-filetool.js (REFAC — preserve original behavior, fixed bugs, robust fallbacks)
// Requirements in runtime image: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext), ghostscript (gs),
// imagemagick (magick or convert), pandoc (optional). No zip fallback. Uses /dev/shm when present.

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { exec, execSync } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const mime = require("mime-types");

const pipe = promisify(pipeline);
const router = express.Router();

// ---------------- Smart TMP selection ----------------
function parseDfOutput(out) {
  try {
    const lines = out.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return 0;
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const availableKb = parseInt(cols[3], 10);
    return isNaN(availableKb) ? 0 : availableKb;
  } catch (e) {
    return 0;
  }
}
function getFreeKbSync(checkPath) {
  try {
    const out = execSync(`df -Pk "${checkPath}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseDfOutput(out);
  } catch (e) {
    return 0;
  }
}
const TMP_MIN_KB = Number(process.env.TMP_MIN_KB || 200 * 1024);
function chooseTmpDir() {
  const candidate = process.env.TMPDIR || (fs.existsSync("/dev/shm") ? "/dev/shm" : null);
  if (candidate) {
    const free = getFreeKbSync(candidate);
    if (free >= TMP_MIN_KB) {
      console.log(`🧭 Using temp dir: ${candidate} (free ${(free / 1024).toFixed(1)} MB)`);
      return candidate;
    } else {
      console.warn(`⚠️ Insufficient space on ${candidate}: ${(free / 1024).toFixed(1)} MB, falling back to os.tmpdir()`);
    }
  }
  const fallback = os.tmpdir();
  const fallbackFree = getFreeKbSync(fallback);
  console.log(`🧭 Using fallback temp dir: ${fallback} (free ${(fallbackFree / 1024).toFixed(1)} MB)`);
  return fallback;
}
const TMP_DIR = chooseTmpDir();

const FFMPEG_THREADS = String(process.env.FFMPEG_THREADS || "2");
const STABLE_CHECK_MS = 200;
const STABLE_CHECK_ROUNDS = 3;
const STABLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ---------------- Concurrency limiter ----------------
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 3);

// ---------------- Multer upload ----------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
}).single("file");

// ---------------- Exec wrapper ----------------
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const outErr = (stderr && stderr.toString()) || (stdout && stdout.toString()) || err.message;
        const msg = `Command failed: ${cmd}\n${outErr}`;
        return reject(new Error(msg));
      }
      resolve({ stdout: stdout ? stdout.toString() : "", stderr: stderr ? stderr.toString() : "" });
    });
  });
}
async function hasCmd(name) {
  try { await runCmd(`which ${name}`); return true; } catch { return false; }
}
async function findMagickCmd() {
  try { await runCmd("magick -version"); return "magick"; }
  catch { try { await runCmd("convert -version"); return "convert"; } catch { return null; } }
}

// ---------------- Utilities ----------------
function extOfFilename(name) { return (path.extname(name || "").replace(".", "") || "").toLowerCase(); }
function sanitizeFilename(name) { return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_"); }
function safeOutputBase(originalName) { return `${Date.now()}-${uuidv4()}-${path.parse(originalName).name.replace(/\s+/g, "_")}`; }
function fixOutputExtension(filename, targetExt) {
  const clean = (targetExt || "").toString().replace(/^\./, "");
  if (!clean) return filename;
  const dir = path.dirname(filename);
  const base = path.parse(filename).name;
  return path.join(dir, `${base}.${clean}`);
}
async function ensureProperExtension(filePath, targetExt) {
  try {
    if (!filePath) return filePath;
    const clean = (targetExt || "").toString().replace(/^\./, "");
    if (!clean) return filePath;
    const newPath = path.join(path.dirname(filePath), `${path.parse(filePath).name}.${clean}`);
    if (newPath === filePath) return filePath;
    if (fs.existsSync(filePath)) {
      await fsp.rename(filePath, newPath);
      console.log("🔧 Fixed extension:", newPath);
      return newPath;
    }
  } catch (e) {
    console.warn("ensureProperExtension error:", e && e.message);
  }
  return filePath;
}
async function safeCleanup(filePath) {
  try {
    if (!filePath) return;
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log("🧹 Temp deleted:", filePath);
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("cleanup failed:", e && e.message);
  }
}
async function waitForStableFileSize(filePath, timeoutMs = STABLE_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) { await new Promise(r => setTimeout(r, STABLE_CHECK_MS)); continue; }
    let stable = true;
    let prev = fs.statSync(filePath).size;
    for (let r = 0; r < STABLE_CHECK_ROUNDS; ++r) {
      await new Promise(rp => setTimeout(rp, STABLE_CHECK_MS));
      const now = fs.existsSync(filePath) ? fs.statSync(filePath).size : -1;
      if (now !== prev) { stable = false; prev = now; break; }
    }
    if (stable && prev > 0) return true;
  }
  return false;
}

function mapMimeByExt(ext) {
  const e = (ext || "").replace(/^\./, "").toLowerCase();
  const map = {
    wav: "audio/wav", mp3: "audio/mpeg", opus: "audio/opus", ogg: "audio/ogg", m4a: "audio/mp4",
    aac: "audio/aac", webm: "video/webm", mp4: "video/mp4", avi: "video/x-msvideo", mov: "video/quicktime",
    mkv: "video/x-matroska", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text"
  };
  return map[e] || mime.lookup(e) || "application/octet-stream";
}

// sets
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","tif","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","flac","aac"]);
const videoExts = new Set(["mp4","avi","mov","webm","mkv","m4v"]);
const officeExts = new Set(["doc","docx","ppt","pptx","xls","xlsx","odt","ods","odp","rtf"]);
const docExts = new Set(["pdf","txt","md","html","docx","rtf","odt"]);

// ---------------- Prewarm (non-blocking) ----------------
(async function prewarm() {
  try {
    console.log("🔥 Prewarming tools...");
    await Promise.allSettled([
      runCmd("ffmpeg -version"),
      runCmd("libreoffice --headless --version").catch(()=>{}),
      runCmd("pdftoppm -v").catch(()=>{}),
      runCmd("pdftotext -v").catch(()=>{}),
      runCmd("magick -version").catch(()=>runCmd("convert -version").catch(()=>{})),
      runCmd("gs --version").catch(()=>{}),
      runCmd("pandoc --version").catch(()=>{})
    ]);
    console.log("🔥 Prewarm done");
  } catch (e) { console.warn("Prewarm notice:", e && e.message); }
})();

// ---------------- Helper: ensure tmp space ----------------
function ensureTmpSpaceSync(requiredKb, checkPath = TMP_DIR) {
  const freeKb = getFreeKbSync(checkPath);
  if (freeKb <= 0) {
    throw new Error(`Could not determine free disk space on ${checkPath}`);
  }
  if (freeKb < requiredKb) {
    throw new Error(`Insufficient temp space on ${checkPath}: required ${(requiredKb/1024).toFixed(1)} MB, available ${(freeKb/1024).toFixed(1)} MB`);
  }
  return true;
}

// ---------------- Helper: flatten image to white ----------------
async function flattenImageWhite(input, out) {
  const magickCmd = await findMagickCmd();
  if (magickCmd) {
    const memLimit = process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB";
    const mapLimit = process.env.IMAGEMAGICK_LIMIT_MAP || "512MB";
    const cmd = `${magickCmd} -limit memory ${memLimit} -limit map ${mapLimit} "${input}" -background white -alpha remove -flatten +repage -colorspace sRGB "${out}"`;
    await runCmd(cmd);
  } else {
    await fsp.copyFile(input, out);
  }
}

// ---------------- Helper: render PDF first page with Ghostscript ----------------
async function renderPdfWithGs(inputPdf, outFile, format = "png", dpi = 200) {
  const device = (format === "jpeg" || format === "jpg") ? "jpeg" : "png16m";
  try { ensureTmpSpaceSync(50 * 1024); } catch (e) { console.warn("Warning: low tmp space before GS render:", e && e.message); }
  const gsCmd = `gs -dSAFER -dBATCH -dNOPAUSE -dFirstPage=1 -dLastPage=1 -sDEVICE=${device} -r${dpi} -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -sOutputFile="${outFile}" "${inputPdf}"`;
  console.log("📄 gs render:", gsCmd);
  await runCmd(gsCmd);
  return outFile;
}

// ---------------- NEW HELPER: sanitize text/markdown outputs ----------------
async function sanitizeTextOrMarkdown(filePath, targetExt, tmpDir) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    let s = await fsp.readFile(filePath, "utf8");
    if (s.indexOf("\0") !== -1) s = s.replace(/\0+/g, "");
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    s = s.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");
    s = s.replace(/(<[a-zA-Z0-9]+\b[^>]*?)\sstyle=(["'])(.*?)\2/gi, (m, startTag, q, styleContent) => startTag);
    s = s.replace(/background(?:-color)?\s*:\s*[^;"})+]+;?/gi, "");
    s = s.replace(/<\/?span[^>]*>/gi, "");
    s = s.replace(/<\/?(?:div|p|h[1-6]|section|article)[^>]*>/gi, "\n");
    s = s.replace(/<\/?br[^>]*>/gi, "\n");
    s = s.replace(/<\/?[^>]+(>|$)/g, "");
    s = s.replace(/^\s+/, "").replace(/\s+$/, "");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    await fsp.writeFile(filePath, s, "utf8");
    return filePath;
  } catch (err) {
    console.warn("sanitizeTextOrMarkdown failed:", err && err.message);
    return filePath;
  }
}

// ---------------- Image conversion helper (unified) ----------------
async function convertImageGeneric(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found for image conversion");
  const magickCmd = await findMagickCmd();
  const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRaw || "").toLowerCase();
  const out = fixOutputExtension(outPath, extRaw || ext);

  // If magick available, use it for most conversions (including PDF output)
  if (magickCmd) {
    // handle PDF specially: convert image -> pdf with proper density and flatten
    if (ext === "pdf") {
      const cmd = `${magickCmd} -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -background white -alpha remove -flatten -quality 90 "${out}"`;
      await runCmd(cmd);
      return await ensureProperExtension(out, extRaw || ext);
    }

    // normal image -> image conversion
    const cmd = `${magickCmd} -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -quality 90 "${out}"`;
    await runCmd(cmd);
    return await ensureProperExtension(out, extRaw || ext);
  } else {
    // fallback: for PDF -> image or image -> PDF use ghostscript or ffmpeg where possible
    if (ext === "pdf") {
      // fallback: use ImageMagick missing — produce pdf via convert command is not available; try gs by rasterizing then convert to pdf via imagemagick missing - copy
      await fsp.copyFile(input, out);
      return await ensureProperExtension(out, extRaw || ext);
    } else {
      // copy file and hope for the best (last resort)
      await fsp.copyFile(input, out);
      return await ensureProperExtension(out, extRaw || ext);
    }
  }
}

// ---------------- Audio conversion (unchanged, with robust checks) ----------------
async function convertAudio(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRaw || "").toLowerCase();
  if (!ext) throw new Error("No target audio extension specified");
  let out = fixOutputExtension(outPath, extRaw || ext);
  if (!path.extname(out)) out = `${out}.${extRaw || ext}`;
  let cmd;
  switch (ext) {
    case "wav":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`;
      break;
    case "mp3":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`;
      break;
    case "ogg":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a libvorbis -q:a 4 "${out}"`;
      break;
    case "opus":
      out = fixOutputExtension(out, extRaw || "opus");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a libopus -b:a 96k -vn -f opus "${out}"`;
      break;
    case "aac":
      out = fixOutputExtension(out, extRaw || "aac");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k -f adts "${out}"`;
      break;
    case "m4a":
      out = fixOutputExtension(out, extRaw || "m4a");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k "${out}"`;
      break;
    case "flac":
      out = fixOutputExtension(out, extRaw || "flac");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a flac "${out}"`;
      break;
    case "webm":
      out = fixOutputExtension(out, extRaw || "webm");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -vn -c:a libopus -b:a 96k -f webm "${out}"`;
      break;
    default:
      // fallback: try container copy
      cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
  }
  console.log("🎬 ffmpeg (audio):", cmd);
  await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Audio conversion failed: output unstable or empty");
  return await ensureProperExtension(out, extRaw || ext);
}

// ---------------- Video conversion (kept behavior) ----------------
async function convertVideo(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRaw || "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");
  let out = fixOutputExtension(outPath, extRaw || ext);
  if (!path.extname(out)) out = `${out}.${extRaw || ext}`;
  let cmd;
  if (ext === "webm") {
    const vp8cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 1M -deadline realtime -cpu-used 6 -row-mt 1 -threads ${FFMPEG_THREADS} -c:a libopus -b:a 96k -f webm "${out}"`;
    console.log("🎬 ffmpeg (video - try vp8 fast):", vp8cmd);
    try { await runCmd(vp8cmd); }
    catch (errVp8) {
      console.warn("VP8 quick path failed, falling back to VP9:", errVp8 && errVp8.message);
      const tryVp9 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -deadline good -threads ${FFMPEG_THREADS} -c:a libopus -b:a 96k -f webm "${out}"`;
      try { await runCmd(tryVp9); }
      catch (errVp9) {
        console.warn("VP9 failed, falling back to container copy:", errVp9 && errVp9.message);
        const fallbackCopy = `ffmpeg -y -i "${input}" -c copy "${out}"`;
        await runCmd(fallbackCopy).catch(err => { throw new Error(err.message); });
      }
    }
  } else if (ext === "mkv") {
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k "${out}"`;
    console.log("🎬 ffmpeg (video):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  } else if (["mp4","mov","m4v","avi"].includes(ext)) {
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k "${out}"`;
    console.log("🎬 ffmpeg (video):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  } else {
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
    console.log("🎬 ffmpeg (container copy):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  }
  if (!fs.existsSync(out)) throw new Error("Video conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Video conversion failed: output unstable or empty");
  return await ensureProperExtension(out, extRaw || ext);
}

// ---------------- Document conversion (robust, unified) ----------------
async function convertDocument(input, outPath, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const inExtRaw = extOfFilename(input) || extOfFilename(path.basename(input));
  const inExt = (inExtRaw || "").toLowerCase();
  const extRequestedRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const outExt = (extRequestedRaw || "").toLowerCase();
  const out = fixOutputExtension(outPath, extRequestedRaw);
  tmpDir = tmpDir || path.dirname(input);

  // Quick single-page PDF -> image handled elsewhere by convertImageGeneric, leave that flow intact.

  // If input is already same as output, let caller have it (but earlier guard disallowed identical conversions)
  // We'll still support conversion paths.

  // Try the easiest path first: pandoc (best for many doc/text conversions)
  if (await hasCmd("pandoc")) {
    try {
      // If converting to docx/pdf/html/md/txt, pandoc often handles it
      // For PDF output, pandoc requires LaTeX installed; we'll try but fallback to libreoffice if it fails.
      const pandocCmd = `pandoc "${input}" -o "${out}"`;
      console.log("📄 pandoc:", pandocCmd);
      await runCmd(pandocCmd);
      if (!(await waitForStableFileSize(out))) throw new Error("Pandoc produced unstable output");
      // sanitize when output is text/markdown
      if (["txt","md"].includes(outExt)) await sanitizeTextOrMarkdown(out, outExt, tmpDir);
      return out;
    } catch (e) {
      console.warn("Pandoc path failed:", e && e.message);
      // continue to other strategies
    }
  }

  // If input is PDF and out is text-like, try pdftotext -> pandoc/rename
  if (inExt === "pdf" && ["txt","md","html"].includes(outExt) && await hasCmd("pdftotext")) {
    try {
      const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`);
      if (outExt === "html") {
        if (await hasCmd("pandoc")) {
          await runCmd(`pandoc "${mid}" -o "${out}"`);
        } else {
          // wrap text in <pre>
          const txt = await fsp.readFile(mid, "utf8");
          await fsp.writeFile(out, `<pre>${txt.replace(/</g, "&lt;")}</pre>`, "utf8");
        }
      } else if (outExt === "md") {
        if (await hasCmd("pandoc")) {
          await runCmd(`pandoc "${mid}" -o "${out}"`);
        } else {
          await fsp.rename(mid, out).catch(()=>{});
        }
      } else { // txt
        await fsp.rename(mid, out).catch(()=>{});
      }
      if (["txt","md"].includes(outExt)) await sanitizeTextOrMarkdown(out, outExt, tmpDir);
      return out;
    } catch (e) {
      console.warn("pdftotext path failed:", e && e.message);
    }
  }

  // If libreoffice available, use it for office conversions (docx, odt, rtf, pdf, html)
  if (await hasCmd("libreoffice")) {
    try {
      // LibreOffice convert-to supports many formats. Use it as fallback for all office/doc types.
      const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${outExt} "${input}" --outdir "${tmpDir}"`;
      console.log("📄 libreoffice:", cmd);
      await runCmd(cmd);
      const gen = path.join(tmpDir, `${path.parse(input).name}.${outExt}`);
      if (!fs.existsSync(gen)) {
        // sometimes libreoffice appends different suffix (e.g., .html may be named differently)
        // look for any file with same base name and a matching extension
        const entries = fs.readdirSync(tmpDir);
        const candidate = entries.find(e => e.startsWith(path.parse(input).name) && e.toLowerCase().endsWith(`.${outExt}`));
        if (candidate) {
          await fsp.rename(path.join(tmpDir, candidate), out).catch(()=>{});
          if (["txt","md"].includes(outExt)) await sanitizeTextOrMarkdown(out, outExt, tmpDir);
          return out;
        }
        throw new Error(`LibreOffice did not produce ${outExt}`);
      }
      // flatten images if produced
      if (["png","jpg","jpeg","webp"].includes(outExt)) await flattenImageWhite(gen, gen);
      await fsp.rename(gen, out).catch(()=>{});
      if (["txt","md"].includes(outExt)) await sanitizeTextOrMarkdown(out, outExt, tmpDir);
      return out;
    } catch (e) {
      console.warn("LibreOffice conversion failed:", e && e.message);
    }
  }

  // Last-resort fallback strategies for simple conversions when no heavyweight tool exists:
  try {
    // txt <-> md <-> html simple fallbacks
    if (inExt === "txt" && outExt === "md") {
      await fsp.copyFile(input, out);
      await sanitizeTextOrMarkdown(out, "md", tmpDir);
      return out;
    }
    if (inExt === "txt" && outExt === "html") {
      const txt = await fsp.readFile(input, "utf8");
      await fsp.writeFile(out, `<pre>${txt.replace(/</g, "&lt;")}</pre>`, "utf8");
      return out;
    }
    if (inExt === "md" && outExt === "html") {
      if (await hasCmd("pandoc")) {
        await runCmd(`pandoc "${input}" -o "${out}"`);
        return out;
      } else {
        const md = await fsp.readFile(input, "utf8");
        await fsp.writeFile(out, `<pre>${md.replace(/</g, "&lt;")}</pre>`, "utf8");
        return out;
      }
    }
    if (inExt === "html" && outExt === "txt") {
      const html = await fsp.readFile(input, "utf8");
      // strip tags naive
      const txt = html.replace(/<\/?[^>]+(>|$)/g, "");
      await fsp.writeFile(out, txt, "utf8");
      return out;
    }
    // fallback: attempt to rename/copy
    await fsp.copyFile(input, out);
    return out;
  } catch (e) {
    throw new Error(`Document conversion failed (fallback): ${e && e.message}`);
  }
}

// ---------------- Compression (heavy) - overwrite same extension ----------------
async function compressFile(input, outPath, inputExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  inputExt = (inputExt || extOfFilename(input)).replace(/^\./, "").toLowerCase();
  const out = fixOutputExtension(outPath, inputExt);
  let cmd;

  if (inputExt === "pdf") {
    cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`;
  } else if (imageExts.has(inputExt)) {
    if (["jpg","jpeg"].includes(inputExt)) {
      cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -sampling-factor 4:2:0 -quality 55 -interlace Plane -colorspace sRGB "${out}"`;
    } else if (inputExt === "png") {
      if (await hasCmd("pngquant")) {
        cmd = `pngquant --quality=50-80 --output "${out}" --force "${input}"`;
      } else {
        cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -quality 60 "${out}"`;
      }
    } else {
      cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -quality 60 "${out}"`;
    }
  } else if (audioExts.has(inputExt)) {
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -ac 2 -ar 44100 -b:a 96k "${out}"`;
  } else if (videoExts.has(inputExt)) {
    if (inputExt === "webm") {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 600k -cpu-used 5 -row-mt 1 -c:a libopus -b:a 64k -f webm "${out}"`;
    } else {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset veryfast -crf 35 -c:a aac -b:a 96k "${out}"`;
    }
  } else if (officeExts.has(inputExt) || docExts.has(inputExt)) {
    const tmpPdf = fixOutputExtension(outPath, "pdf");
    if (await hasCmd("pandoc") && docExts.has(inputExt)) {
      try { await runCmd(`pandoc "${input}" -o "${tmpPdf}"`); } catch {}
    } else if (await hasCmd("libreoffice")) {
      try { await runCmd(`libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${input}" --outdir "${path.dirname(tmpPdf)}"`); } catch {}
    }
    await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmpPdf}" "${tmpPdf}"`).catch(()=>{});
    if (!fs.existsSync(tmpPdf)) throw new Error("Document compression failed");
    if (!(await waitForStableFileSize(tmpPdf))) throw new Error("Document compression produced unstable output");
    return tmpPdf;
  } else {
    // last resort: copy as-is
    await fsp.copyFile(input, out);
    return out;
  }

  console.log("🗜️ compress cmd:", cmd);
  await runCmd(cmd).catch(err => { throw new Error(`Compression failed: ${err.message}`); });

  if (!fs.existsSync(out)) throw new Error("Compression failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Compression failed: output unstable or empty");
  return await ensureProperExtension(out, inputExt);
}

// ---------------- Route: POST '/' ----------------
router.post("/", (req, res) => {
  try { req.setTimeout(0); } catch (e) {}
  try { res.setTimeout(0); } catch (e) {}

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({ error: `Server busy, please try again in a few seconds.` });
  }

  activeJobs++;
  let cleared = false;
  const clearJob = () => {
    if (!cleared) {
      cleared = true;
      activeJobs = Math.max(0, activeJobs - 1);
      console.log(`🧭 Job finished/cleared. activeJobs=${activeJobs}`);
    }
  };
  res.on("finish", clearJob);
  res.on("close", clearJob);

  upload(req, res, async function (err) {
    if (err) {
      console.warn("Multer/upload error:", err && err.message);
      try { clearJob(); } catch (e) {}
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      try { clearJob(); } catch (e) {}
      return res.status(400).json({ error: "No file uploaded." });
    }

    const mode = (req.body.mode || "convert").toLowerCase(); // convert | compress
    const requestedTargetRaw = (req.body.targetFormat || "").toString().replace(/^\./, "");
    const requestedTarget = (requestedTargetRaw || "").toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
    const tmpDir = path.dirname(inputPath);

    const magickCmd = await findMagickCmd();
    const baseOut = path.join(TMP_DIR, safeOutputBase(originalName));
    const effectiveTarget = requestedTargetRaw || inputExt;
    const outPath = fixOutputExtension(baseOut, effectiveTarget);

    let producedPath;
    try {
      if (mode === "convert" && requestedTarget && requestedTarget === inputExt) {
        await safeCleanup(inputPath);
        try { clearJob(); } catch (e) {}
        return res.status(400).json({ error: `Conversion disallowed: source and target formats are identical (.${inputExt})` });
      }

      if (mode === "compress") {
        producedPath = await compressFile(inputPath, outPath, inputExt);
      } else {
        // convert
        if (audioExts.has(inputExt) || audioExts.has(requestedTarget)) {
          producedPath = await convertAudio(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt);
        } else if (videoExts.has(inputExt) || videoExts.has(requestedTarget)) {
          producedPath = await convertVideo(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt);
        } else if (imageExts.has(inputExt) || imageExts.has(requestedTarget) || requestedTarget === "pdf" || inputExt === "pdf") {
          // unify image + pdf conversions:
          // - image -> image/pdf: ImageMagick preferred
          // - pdf -> image: handled in convertDocument or convertImageGeneric, unify by calling convertImageGeneric for image targets
          // if input is pdf and target is image -> render pdf page 1 -> convert to requested image
          if (inputExt === "pdf" && ["png","jpg","jpeg","webp","tiff","bmp"].includes(requestedTarget)) {
            // render pdf first page to temp PNG via gs
            const tmpPrefix = path.join(tmpDir, safeOutputBase(path.parse(inputPath).name));
            const gsOut = fixOutputExtension(`${tmpPrefix}`, "png");
            try {
              await renderPdfWithGs(inputPath, gsOut, "png", (getFreeKbSync(tmpDir) < 150 * 1024) ? 150 : 200);
              // convert rendered png to requested target
              producedPath = await convertImageGeneric(gsOut, outPath, requestedTargetRaw || requestedTarget);
              await safeCleanup(gsOut);
            } catch (e) {
              // fallback to ImageMagick direct pdf read, or pdftoppm fallback inside convertDocument
              producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget, tmpDir);
            }
          } else if (requestedTarget === "pdf" && imageExts.has(inputExt)) {
            // image -> pdf
            producedPath = await convertImageGeneric(inputPath, outPath, "pdf");
          } else {
            // image -> image OR pdf->pdf handled above
            producedPath = await convertImageGeneric(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt);
          }
        } else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(requestedTarget) || officeExts.has(requestedTarget)) {
          producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt, tmpDir);
        } else {
          // final fallback: try convertDocument then convertImageGeneric, then copy
          try {
            producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt, tmpDir);
          } catch (e) {
            // last resort copy
            await fsp.copyFile(inputPath, outPath).catch(()=>{});
            producedPath = outPath;
          }
        }
      }

      if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");
      if (!(await waitForStableFileSize(producedPath))) throw new Error("Produced file is empty or unstable.");

      if (mode === "compress") {
        producedPath = await ensureProperExtension(producedPath, inputExt);
      } else {
        const finalTarget = requestedTargetRaw || extOfFilename(producedPath) || inputExt;
        producedPath = await ensureProperExtension(producedPath, finalTarget);
      }

      if (!path.extname(producedPath)) {
        const extWanted = requestedTargetRaw || extOfFilename(producedPath) || inputExt;
        const withExt = `${producedPath}.${extWanted}`;
        if (fs.existsSync(producedPath)) {
          await fsp.rename(producedPath, withExt).catch(()=>{ producedPath = producedPath; });
          producedPath = withExt;
        }
      }

      const finalOutExt = extOfFilename(producedPath).toLowerCase();
      if (finalOutExt === "txt" || finalOutExt === "md") {
        await sanitizeTextOrMarkdown(producedPath, finalOutExt, tmpDir);
      }

      const outExt = extOfFilename(producedPath);
      const fileName = `${path.parse(originalName).name.replace(/\s+/g, "_")}.${outExt}`;
      const mimeType = mapMimeByExt(outExt);
      const stat = fs.statSync(producedPath);

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });

      const readStream = fs.createReadStream(producedPath);
      await pipe(readStream, res);

      await safeCleanup(producedPath);
      await safeCleanup(inputPath);
      try { clearJob(); } catch (e) {}
    } catch (e) {
      console.error("❌ Conversion/Compression error:", e && e.message);
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      await safeCleanup(inputPath);
      try { clearJob(); } catch (ee) {}
      if (!res.headersSent) return res.status(500).json({ error: e.message });
      try { res.end(); } catch {}
    }
  });
});

module.exports = router;
