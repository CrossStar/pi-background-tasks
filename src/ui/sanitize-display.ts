/** Remove terminal commands before measuring or rendering untrusted text.
 * Only 7-bit SGR is retained when explicitly requested for themed rows.
 * Unterminated control strings consume the remainder rather than leaking payload.
 */
export function sanitizeDisplay(text: string, preserveSgr = false, multiline = false): string {
  let result = '';
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i++);
    let introducer = code;
    if (code === 0x1b) {
      if (i === text.length) break;
      introducer = text.charCodeAt(i++) + 0x40;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(introducer)) {
      while (i < text.length) {
        const c = text.charCodeAt(i++);
        if (c === 0x9c || (introducer === 0x9d && c === 7)) break;
        if (c === 0x1b && text[i] === '\\') { i++; break; }
      }
      continue;
    }
    if (introducer === 0x9b) {
      const start = i;
      while (i < text.length && !/[\x40-\x7e]/.test(text.charAt(i))) i++;
      if (i < text.length) {
        const params = text.slice(start, i);
        const final = text[i++];
        if (preserveSgr && code === 0x1b && final === 'm' && /^[0-9:;]*$/.test(params)) result += `\x1b[${params}m`;
      }
      continue;
    }
    if (code === 0x1b) {
      while (i < text.length && text.charCodeAt(i - 1) >= 0x20 && text.charCodeAt(i - 1) <= 0x2f) i++;
      continue;
    }
    if ((code === 10 || code === 13) && multiline) result += String.fromCharCode(code);
    else if (code === 9 || code === 10 || code === 13) result += ' ';
    else if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) result += String.fromCharCode(code);
  }
  return result;
}
