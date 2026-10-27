const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validProfile(input) {
  const name = String(input.name || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const baseUrl = String(input.baseUrl || '').trim();
  const key = String(input.key || '').trim();
  if (!name || name.length > 100 || !model || model.length > 200 || !/^[a-z0-9_-]{1,40}$/.test(provider) || key.length > 4096) throw new Error('请填写有效的配置名称、供应商代码和模型名称');
  if (['azure', 'bedrock', 'chatgpt'].includes(provider)) throw new Error('此认证方式需要额外配置，请使用通用兼容接口或其他支持 API key 的供应商');
  if (provider === 'openai_compatible' && !baseUrl) throw new Error('通用兼容接口需要填写 API 地址');
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('API 地址无效'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API 地址必须为 HTTPS 或本机 HTTP，且不能包含凭据、查询参数或片段');
  }
  return { name, provider, model, baseUrl, key };
}

function createProfileStore(file, safeStorage) {
  function load() {
    if (!fs.existsSync(file)) return { profiles: [], selectedId: null };
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法读取已保存的 API 配置');
    const encrypted = fs.readFileSync(file);
    let plaintext;
    try { plaintext = safeStorage.decryptString(encrypted); }
    catch { throw new Error('无法解密已保存的连接，请确认 Windows 登录账户；原配置文件未更改'); }
    let data;
    try { data = JSON.parse(plaintext); }
    catch { throw new Error('已保存的连接文件格式无效；原配置文件未更改'); }
    const valid = data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.profiles)
      && data.profiles.every(p => p && typeof p.id === 'string' && typeof p.name === 'string'
        && typeof p.provider === 'string' && typeof p.model === 'string'
        && (p.baseUrl == null || typeof p.baseUrl === 'string') && (p.key == null || typeof p.key === 'string'))
      && (data.selectedId == null || (typeof data.selectedId === 'string' && data.profiles.some(p => p.id === data.selectedId)));
    if (!valid) throw new Error('已保存的连接文件格式无效；原配置文件未更改');
    return data;
  }
  function save(data) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法安全保存 API 配置');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(data)), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function publicData(data) {
    return { selectedId: data.selectedId, profiles: data.profiles.map(({ key, ...p }) => ({ ...p, hasKey: Boolean(key) })) };
  }
  return {
    list: () => publicData(load()),
    get: id => { const profile = load().profiles.find(p => p.id === id); if (!profile) throw new Error('请选择已保存的 API 配置'); return profile; },
    put(input) {
      const data = load();
      const old = input.id ? data.profiles.find(p => p.id === input.id) : null;
      if (input.id && !old) throw new Error('配置不存在');
      const p = validProfile(input);
      if (old?.key && !p.key && (old.provider !== p.provider || old.baseUrl !== p.baseUrl)) throw new Error('更改供应商或 API 地址时，请重新输入密钥');
      if (old && !p.key) p.key = old.key;
      let decodedUrl = p.baseUrl;
      try { decodedUrl = decodeURIComponent(p.baseUrl); } catch { throw new Error('API 地址的编码无效'); }
      if (p.key && p.baseUrl && (p.baseUrl.includes(p.key) || decodedUrl.includes(p.key))) throw new Error('API 地址不能包含密钥，请将密钥填入专用字段');
      p.id = old ? old.id : crypto.randomUUID();
      if (old) data.profiles[data.profiles.indexOf(old)] = p; else data.profiles.push(p);
      data.selectedId = p.id;
      save(data);
      return publicData(data);
    },
    select(id) { const data = load(); if (!data.profiles.some(p => p.id === id)) throw new Error('配置不存在'); data.selectedId = id; save(data); return publicData(data); },
    delete(id) { const data = load(); if (!data.profiles.some(p => p.id === id)) throw new Error('配置不存在'); data.profiles = data.profiles.filter(p => p.id !== id); if (data.selectedId === id) data.selectedId = data.profiles[0]?.id || null; save(data); return publicData(data); },
    backupUnreadable() {
      if (!fs.existsSync(file)) throw new Error('没有需要备份的连接文件');
      try { load(); } catch (error) {
        if (!error.message.startsWith('无法解密') && !error.message.startsWith('已保存的连接文件格式无效')) throw error;
        const backup = `${file}.backup-${crypto.randomUUID()}`;
        fs.renameSync(file, backup);
        return backup;
      }
      throw new Error('连接文件可以正常读取，无需重新配置');
    },
  };
}
module.exports = { createProfileStore, validProfile };
