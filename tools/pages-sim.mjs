// Static file server that mimics GitHub Pages: serves dist/ under /repo/ so we can
// prove the site works from a subpath. Dev-only, not part of the app.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve("dist"); const PREFIX = "/repo/"; const PORT = Number(process.env.PORT || 8088);
const MIME = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png"};
http.createServer((req,res)=>{
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404); return res.end("outside prefix"); }
  const rel = url.pathname.slice(PREFIX.length) || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(file.endsWith("/")?path.join(file,"index.html"):file,(err,buf)=>{
    if(err){res.writeHead(404,{"Content-Type":"text/plain"});return res.end("404");}
    res.writeHead(200,{"Content-Type":MIME[path.extname(file)]||"application/octet-stream"}); res.end(buf);
  });
}).listen(PORT,"127.0.0.1",()=>console.log(`pages-sim http://127.0.0.1:${PORT}${PREFIX}`));
