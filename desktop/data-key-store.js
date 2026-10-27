const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createDataKeyStore(file, safeStorage) {
  function get() {
    if (!fs.existsSync(file)) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法读取数据服务密钥');
    let key;
    try { key = safeStorage.decryptString(fs.readFileSync(file)); }
    catch { throw new Error('无法解密已保存的数据服务密钥，原文件未更改'); }
    if (!/^[a-z0-9]{32}$/.test(key)) throw new Error('已保存的数据服务密钥格式无效，原文件未更改');
    return key;
  }
  return {
    get,
    status: () => ({ hasKey: Boolean(get()) }),
    put(input) {
      const key = String(input || '').trim();
      if (!key) return this.status();
      if (!/^[a-z0-9]{32}$/.test(key)) throw new Error('FRED 密钥应为 32 位小写字母或数字，请检查输入');
      // Never replace a file that the current user cannot decrypt.
      get();
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法安全保存数据服务密钥');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temp, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return { hasKey: true };
    },
    remove() { get(); if (fs.existsSync(file)) fs.unlinkSync(file); return { hasKey: false }; },
    backupUnreadable() {
      if (!fs.existsSync(file)) throw new Error('没有需要备份的数据服务密钥文件');
      try { get(); } catch (error) {
        if (!error.message.startsWith('无法解密已保存的数据服务密钥') && !error.message.startsWith('已保存的数据服务密钥格式无效')) throw error;
        const backup = `${file}.backup-${crypto.randomUUID()}`;
        fs.renameSync(file, backup);
        return backup;
      }
      throw new Error('数据服务密钥可以正常读取，无需重新配置');
    },
  };
}
module.exports = { createDataKeyStore };
