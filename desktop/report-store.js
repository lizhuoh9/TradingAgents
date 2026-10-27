const fs = require('node:fs');
const path = require('node:path');

function directories(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);
}

function createReportStore(root) {
  function list({ includeIncomplete = false } = {}) {
    const items = [];
    function add(parent, date, ticker, run = '') {
      for (const name of directories(parent)) {
        const file = path.join(parent, name, 'complete_report.md');
        try {
          if (!fs.lstatSync(file).isFile()) continue;
          const id = path.relative(root, file);
          items.push({ id, date, ticker, title: run ? `${name} · ${run}` : name, time: fs.statSync(file).mtimeMs });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const date of directories(root).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x))) {
      for (const ticker of directories(path.join(root, date))) {
        const base = path.join(root, date, ticker);
        add(path.join(base, 'reports'), date, ticker);
        for (const run of directories(base).filter(x => x.startsWith('run-'))) {
          const runPath = path.join(base, run);
          if (!includeIncomplete && fs.existsSync(path.join(runPath, '.run-incomplete'))) continue;
          add(path.join(runPath, 'reports'), date, ticker, run);
        }
      }
    }
    add(path.join(root, 'reports'), '', '');
    return items.sort((a, b) => b.time - a.time);
  }
  return {
    list,
    read(id) {
      const item = list().find(x => x.id === id);
      if (!item) throw new Error('报告不存在');
      const file = path.join(root, item.id);
      const realRoot = fs.realpathSync(root) + path.sep;
      if (!fs.realpathSync(file).startsWith(realRoot) || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('报告路径无效或文件过大');
      return { title: item.title, text: fs.readFileSync(file, 'utf8') };
    },
  };
}
module.exports = { createReportStore };
