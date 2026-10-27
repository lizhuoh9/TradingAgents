const http = require('node:http');
const https = require('node:https');

function modelUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 API 地址'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须为 HTTPS 或本机 HTTP，且不能包含凭据或查询参数');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models';
  return url;
}

function credentialForRequest(input, profiles) {
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (key || !input.profileId) return key;
  const profile = profiles.get(input.profileId);
  if (profile.key && (profile.provider !== input.provider || (profile.baseUrl || '') !== input.baseUrl)) {
    throw new Error('服务类型或地址已改变，请重新输入密钥后测试');
  }
  return profile.key || '';
}

function fetchAvailableModels(baseUrl, key, { timeoutMs = 12000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const url = modelUrl(baseUrl);
  if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('密钥格式无效');
  let decoded;
  try { decoded = decodeURIComponent(url.href); } catch { throw new Error('API 地址的编码无效'); }
  if (key && (url.href.includes(key) || decoded.includes(key))) throw new Error('API 地址不能包含密钥，请将密钥填入专用字段');
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timer;
    const fail = message => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(message)); } };
    let req;
    try {
      req = transport.request(url, { method: 'GET', headers }, res => {
        res.on('error', () => fail('读取模型列表失败'));
        if (res.statusCode >= 300 && res.statusCode < 400) { fail('服务返回了重定向；为保护密钥，请填写正确的 API 地址'); res.destroy(); return; }
        if (res.statusCode !== 200) {
          const code = res.statusCode;
          fail(code === 401 || code === 403 ? '连接失败：密钥无效或无访问权限' : code === 404 ? '连接失败：该地址没有模型列表接口' : `连接失败：服务返回状态 ${code}`);
          res.destroy();
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { fail('服务返回了不支持的响应格式'); res.destroy(); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { fail('模型列表过大'); req.destroy(); } else chunks.push(chunk); });
        res.on('aborted', () => fail('读取模型列表时连接中断'));
        res.on('end', () => {
          if (settled) return;
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { fail('服务返回的模型列表不是有效 JSON'); return; }
          if (!Array.isArray(body?.data)) { fail('服务没有返回兼容的模型列表'); return; }
          const models = []; const seen = new Set();
          for (const item of body.data) {
            const id = typeof item?.id === 'string' ? item.id.trim() : '';
            if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id) || (key && id.includes(key))) continue;
            const name = typeof item.name === 'string' ? item.name.trim().slice(0, 200) : '';
            seen.add(id); models.push({ id, label: name && !(key && name.includes(key)) ? name : id });
            if (models.length >= 5000) break;
          }
          settled = true; clearTimeout(timer); resolve({ models });
        });
      });
    } catch { fail('无法发起连接，请检查地址和密钥格式'); return; }
    req.on('error', () => fail('无法连接服务，请检查地址和网络'));
    timer = setTimeout(() => { fail('连接超时，请检查地址和网络'); req.destroy(); }, timeoutMs);
    req.end();
  });
}
module.exports = { modelUrl, credentialForRequest, fetchAvailableModels };
