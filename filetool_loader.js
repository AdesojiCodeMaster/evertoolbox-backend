// filetool_loader.js
const fileRouter = require("./routes/filetools_v5.js");

function attachFileTool(app) {
  try {
    app.use("/api/tools/file", fileRouter);
    console.log("✅ File Converter & Compressor tool successfully attached.");
  } catch (err) {
    console.error("❌ Failed to attach File Converter & Compressor tool:", err);
  }
}

module.exports = { attachFileTool };
