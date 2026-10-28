// Release tooling: keep the immutable GitHub files and Windows installations byte-identical.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const file = path.join(__dirname, 'ui-release.json');
const check = process.argv[2] === '--check';
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const version = check ? previous?.version : process.argv[2];
if (typeof version !== 'string' || version !== version.trim() || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) throw new Error('用法：node ui-release.cjs <界面版本，如 0.2.1> 或 --check');
const manifest = { schema: 1, version, hostVersion: require('./package.json').version, files: {} };
for (const name of ['index.html', 'renderer.js', 'style.css']) {
  const target = path.join(__dirname, name);
  let bytes = fs.readFileSync(target);
  if (!check) {
    bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    fs.writeFileSync(target, bytes);
  }
  manifest.files[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
if (check) assert.deepEqual(previous, manifest, '界面发行清单与当前文件不一致；发布前更新版本和校验值');
else fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(check ? 'UI release manifest verified.' : `UI release ${version} prepared.`);
