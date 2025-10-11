const fileRouter = require("./routes/filetools_v5.js");

function attachFileTool(app) {
  try {
    app.use("/api/tools/file", fileRouter);
    console.log("✅ File Converter & Compressor tool loaded");
  } catch (err) {
    console.error("⚠️ Failed to load File Converter Tool:", err);
  }
}

module.exports = { attachFileTool };
