// web-deploy-static-server.cjs — 以某个目录为站点根提供静态服务，并记录每个请求的状态码
//
// Usage: node web-deploy-static-server.cjs
//   站点根与端口通过环境变量传入（见 verify-web-deploy.ps1）：
//     WEB_DEPLOY_SITE_ROOT  站点根目录
//     WEB_DEPLOY_PORT       监听端口，默认 8137
//
// 之所以不用命令行参数：本仓库路径含中文，Start-Process 传参不保证保留非 ASCII
// 字符，走环境变量可以避开这层编码转换。
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.env.WEB_DEPLOY_SITE_ROOT;
const port = Number(process.env.WEB_DEPLOY_PORT) || 8137;

if (!root || !fs.existsSync(root)) {
  console.error(`站点根无效: ${root}`);
  process.exit(1);
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

const seen = [];
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, urlPath);
  if (urlPath.endsWith('/')) { file = path.join(file, 'index.html'); }
  fs.readFile(file, (err, data) => {
    const status = err ? 404 : 200;
    seen.push({ path: urlPath, status });
    console.log(`${status} ${urlPath}`);
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => console.log(`LISTENING http://127.0.0.1:${port}/ root=${root}`));

process.on('SIGINT', () => {
  const misses = seen.filter(s => s.status === 404);
  console.log('RESULT ' + JSON.stringify({ total: seen.length, misses }));
  server.close(() => process.exit(0));
});
