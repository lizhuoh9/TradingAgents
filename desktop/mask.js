function createMask(secret) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean).sort((a, b) => b.length - a.length);
  const maxLength = secrets.reduce((max, value) => Math.max(max, value.length), 0);
  let tail = '';
  return (text, last = false) => {
    tail += text;
    for (const value of secrets) tail = tail.split(value).join('[REDACTED]');
    const keep = last || !maxLength ? 0 : Math.min(tail.length, maxLength - 1);
    const visible = keep ? tail.slice(0, -keep) : tail;
    tail = keep ? tail.slice(-keep) : '';
    return visible;
  };
}
module.exports = { createMask };
