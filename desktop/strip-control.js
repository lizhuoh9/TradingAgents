function createControlStripper() {
  let state = 'text';
  return text => {
    let output = '';
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (state === 'text') {
        if (ch === '\x1b') state = 'escape';
        else if (ch === '\x9b') state = 'csi';
        else if (ch === '\x9d') state = 'osc';
        else output += ch;
      } else if (state === 'escape') {
        if (ch === '[') state = 'csi';
        else if (ch === ']') state = 'osc';
        else if (code >= 0x30 && code <= 0x7e) state = 'text';
      } else if (state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) state = 'text';
      } else if (state === 'osc') {
        if (ch === '\x07') state = 'text';
        else if (ch === '\x1b') state = 'osc-escape';
      } else if (state === 'osc-escape') {
        state = ch === '\\' ? 'text' : 'osc';
      }
    }
    return output;
  };
}
module.exports = { createControlStripper };
