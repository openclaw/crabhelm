// POSIX shell quoting and word splitting for the ssh command line that
// "crabbox ssh" prints. Only single quotes, double quotes and backslashes
// are handled; that is all crabbox emits.

export function quote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

export function splitWords(line) {
  const words = [];
  let word = "";
  let started = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated single quote");
      word += line.slice(i + 1, end);
      started = true;
      i = end + 1;
    } else if (ch === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) i += 1;
        word += line[i];
        i += 1;
      }
      if (i >= line.length) throw new Error("unterminated double quote");
      started = true;
      i += 1;
    } else if (ch === "\\") {
      if (i + 1 < line.length) word += line[i + 1];
      started = true;
      i += 2;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
      i += 1;
    } else {
      word += ch;
      started = true;
      i += 1;
    }
  }
  if (started) words.push(word);
  return words;
}
