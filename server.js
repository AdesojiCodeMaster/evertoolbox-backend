
// server.js (CommonJS) - EverToolbox backend (complete)
// Usage: node server.js
// NOTE: For document conversions this uses "soffice" (LibreOffice) which must be installed on the host.

const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch'); // v2 style require
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { exec } = require('child_process');
const sharp = require('sharp');
const googleTTS = require('google-tts-api'); // generate base64 audio
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');



const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

    //routes/filetools_v5.js for Converter+ Compressor 
//==========================≈======================≠==========
//import filetoolsV5 from './routes/filetools_v5.js';
//app.use('/api/tools/file', filetoolsV5);

//const filetoolsV5 = require('./routes/filetools_v5.js');
//app.use('/api/tools/file', filetoolsV5);

//=====≈=====================================================≈=


// storage
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random()*1e6)}-${file.originalname}`;
    cb(null, unique);
  }
});
const upload = multer({ storage });

// --------------------
// Helpers
// --------------------
function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

// Serve simple root
app.get('/', (req, res) => {
  res.send('EverToolbox Backend is running ✅');
});

// --------------------
// 1) SEO Analyzer
// GET /api/seo-analyze?url=<url>
// --------------------
app.get('/api/seo-analyze', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url query parameter' });

  try {
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return res.status(r.status).json({ error: `Failed to fetch URL: ${r.status}` });
    const html = await r.text();
    const $ = cheerio.load(html);

    const title = $('title').text() || '';
    const description = $('meta[name="description"]').attr('content') || '';
    const issues = [];
    if (title.length < 30 || title.length > 65) issues.push('Title length should be 30–65 characters.');
    if (description.length < 70 || description.length > 160) issues.push('Meta description should be 70–160 characters.');

    return res.json({ title, description, issues });
  } catch (err) {
    console.error('SEO analyze failed', err);
    return res.status(500).json({ error: 'Failed to analyze page.' });
  }
});

// --------------------
// 2) Text-to-Speech (TTS)
// POST /api/tts  body: { text: "...", lang: "en" }
// returns audio/mpeg (MP3)
// --------------------

// --- TTS endpoint with translation + speech ---
// Place this near other routes in your server.js


const { franc } = require('franc');
// ====== TTS Handler (OpenAI + Google fallback) ======
   
 app.post('/api/tts', async (req, res) => {
  try {
    const { text, lang } = req.body;
    if (!text || !lang) {
      return res.status(400).json({ error: 'Missing text or lang' });
    }

    // Step 1: Translate text to target language using Google Translate endpoint
    const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
    const translateResp = await fetch(translateUrl);
    const translateData = await translateResp.json();

    const translatedText = translateData[0]?.map(x => x[0]).join(' ');
    if (!translatedText) {
      return res.status(500).json({ error: 'Translation failed' });
    }

    console.log(`Translated to [${lang}]:`, translatedText);

    // Step 2: Generate TTS from translated text
    const googleTTS = await import('google-tts-api');
    const url = googleTTS.getAudioUrl(translatedText, {
      lang,
      slow: false,
      host: 'https://translate.google.com',
    });

    // Step 3: Fetch MP3 and send it back
    const audioResp = await fetch(url);
    const audioBuf = await audioResp.arrayBuffer();

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="speech.mp3"',
    });
    res.send(Buffer.from(audioBuf));
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});
      




// --------------------
// 3) Document conversion (uses LibreOffice 'soffice')
// POST /api/convert-doc  form-data: file=...  + field targetExt (e.g. .pdf or pdf)
// returns converted file for download
// --------------------
app.post('/api/convert-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let target = req.body.targetExt || req.query.targetExt || req.body.target || req.query.target || 'pdf';
    // normalize
    if (target.startsWith('.')) target = target.slice(1);
    const inputPath = req.file.path;
    const inputName = req.file.filename;
    const outDir = UPLOAD_DIR;
    const cmd = `soffice --headless --convert-to ${target} --outdir ${outDir} ${inputPath}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('LibreOffice convert error', err, stderr);
        // cleanup input file
        try { fs.unlinkSync(inputPath); } catch(e) {}
        return res.status(500).json({ error: 'Document conversion failed on server. Ensure LibreOffice is installed.' });
      }
      // LibreOffice outputs file with same base name but new ext
      const base = inputName.replace(/\.[^/.]+$/, '');
      const outputFile = path.join(outDir, `${base}.${target}`);
      if (!fs.existsSync(outputFile)) {
        // maybe soffice used a different name, try to find matching file modified recently
        const found = fs.readdirSync(outDir).filter(f => f.includes(base) && f.endsWith(`.${target}`))[0];
        if (found) {
          return res.download(path.join(outDir, found), found, (errDown) => {
            try { fs.unlinkSync(inputPath); } catch(e) {}
            try { fs.unlinkSync(path.join(outDir, found)); } catch(e) {}
          });
        } else {
          try { fs.unlinkSync(inputPath); } catch(e) {}
          return res.status(500).json({ error: 'Converted file not found.' });
        }
      }
      // send file and cleanup
      res.download(outputFile, path.basename(outputFile), (errDown) => {
        try { fs.unlinkSync(inputPath); } catch(e) {}
        try { fs.unlinkSync(outputFile); } catch(e) {}
      });
    });
  } catch (err) {
    console.error('convert-doc error', err);
    return res.status(500).json({ error: 'Server conversion failed' });
  }
});

// --------------------
// 4) Image conversion & simple editor via Sharp
// POST /api/convert-image  form-data: file=...   optional query or body: format=png|jpeg|webp , width, height, brightness (-100..100), overlayText, overlayColor, overlayOpacity, fontSize
// returns image binary
// --------------------
app.post('/api/convert-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const format = (req.body.format || req.query.format || 'png').toLowerCase();
    const width = req.body.width || req.query.width ? parseInt(req.body.width || req.query.width) : null;
    const height = req.body.height || req.query.height ? parseInt(req.body.height || req.query.height) : null;
    const brightness = req.body.brightness || req.query.brightness ? parseInt(req.body.brightness || req.query.brightness) : 0;
    const overlayText = req.body.overlayText || req.query.overlayText || '';
    const overlayColor = req.body.overlayColor || req.query.overlayColor || '#000000';
    const overlayOpacity = req.body.overlayOpacity || req.query.overlayOpacity ? parseFloat(req.body.overlayOpacity || req.query.overlayOpacity) : 0;
    const fontSize = req.body.fontSize || req.query.fontSize ? parseInt(req.body.fontSize || req.query.fontSize) : 36;

    let img = sharp(req.file.path, { failOnError: false });
    if (width || height) img = img.resize(width || null, height || null, { fit: 'inside' });
    if (brightness && brightness !== 0) {
      const mul = 1 + (brightness / 100);
      img = img.modulate({ brightness: mul });
    }

    let buffer = await img.toBuffer();

    // overlay text if requested using SVG composite
    if (overlayText && overlayText.trim()) {
      const meta = await sharp(buffer).metadata();
      const svg = `<svg width="${meta.width}" height="${meta.height}">
        <rect width="100%" height="100%" fill="rgba(0,0,0,0)" />
        <style>
          .t { fill: ${overlayColor}; font-size: ${fontSize}px; font-family: sans-serif; text-anchor: middle; dominant-baseline: middle;}
        </style>
        <text x="50%" y="50%" class="t">${escapeXml(overlayText)}</text>
      </svg>`;
      buffer = await sharp(buffer).composite([{ input: Buffer.from(svg), gravity: 'center' }]).toBuffer();
    }

    // convert format
    let outBuf;
    if (format === 'jpeg' || format === 'jpg') {
      outBuf = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      res.type('jpeg');
    } else if (format === 'webp') {
      outBuf = await sharp(buffer).webp({ quality: 90 }).toBuffer();
      res.type('webp');
    } else {
      outBuf = await sharp(buffer).png().toBuffer();
      res.type('png');
    }

    // cleanup uploaded file
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.send(outBuf);
  } catch (err) {
    console.error('convert-image error', err);
    try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: 'Image conversion failed' });
  }
});

// escape xml for svg insertion
function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// --------------------
// 5) Zip: create zip from uploaded files
// POST /api/zip form-data with files: files (multiple)
// returns zip
// --------------------
app.post('/api/zip', upload.array('files'), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const zipName = `archive-${Date.now()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send({ error: err.message }));
  archive.pipe(res);
  req.files.forEach(f => {
    archive.file(f.path, { name: f.originalname });
  });
  archive.finalize();
  // Note: files will remain in uploads; consider a cleanup job. For now we keep them for safety.
});

// --------------------
// 6) Unzip: accept zip, extract to temp folder and return list + download links
// POST /api/unzip form-data: file=zip
// returns { id: "<id>", files: [ {name, url} ] }
// ---- GET /api/temp/:id/:filename to download
// --------------------
app.post('/api/unzip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip uploaded' });
  const id = uuidv4();
  const extractDir = path.join(UPLOAD_DIR, `unzip-${id}`);
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    await fs.createReadStream(req.file.path).pipe(unzipper.Extract({ path: extractDir })).promise();
    // remove uploaded zip
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    const files = fs.readdirSync(extractDir).map(name => ({ name, url: `/api/temp/${id}/${encodeURIComponent(name)}` }));
    return res.json({ id, files });
  } catch (err) {
    console.error('unzip error', err);
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e){}
    return res.status(500).json({ error: 'Failed to unzip' });
  }
});

// Serve extracted files
app.get('/api/temp/:id/:filename', (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  const dir = path.join(UPLOAD_DIR, `unzip-${id}`);
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, filename, (err) => {
    if (err) console.error('temp download error', err);
    // optionally: delete after download -- we won't auto-delete to avoid race conditions
  });
});




// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`EverToolbox backend listening on port ${PORT}`);
});
