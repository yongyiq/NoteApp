const fs = require('fs');
const path = require('path');

// 递归复制文件夹
function copyFolderSync(from, to) {
  if (!fs.existsSync(from)) return;
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  const elements = fs.readdirSync(from);
  for (const element of elements) {
    const fromPath = path.join(from, element);
    const toPath = path.join(to, element);
    const stat = fs.lstatSync(fromPath);
    if (stat.isFile()) {
      fs.copyFileSync(fromPath, toPath);
    } else if (stat.isDirectory()) {
      copyFolderSync(fromPath, toPath);
    }
  }
}

try {
  // 确保 dist 目录存在
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }

  // 复制单文件
  fs.copyFileSync('index.html', 'dist/index.html');
  fs.copyFileSync('style.css', 'dist/style.css');
  fs.copyFileSync('app.js', 'dist/app.js');
  fs.copyFileSync('web-storage.js', 'dist/web-storage.js');

  // 复制 lib 目录
  copyFolderSync('lib', 'dist/lib');

  console.log('Frontend built to dist/ successfully via Node.js!');
} catch (err) {
  console.error('Failed to build frontend:', err);
  process.exit(1);
}
