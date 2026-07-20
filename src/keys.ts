/**
 * Translation from human-friendly key tokens to the exact byte sequences a
 * terminal application receives. This is what lets a caller press Ctrl-X,
 * arrow keys, function keys, Escape, Tab, etc. against an interactive remote
 * shell (bash, vi, RouterOS CLI, ...) without knowing the raw escape codes.
 *
 * Tokens are case-insensitive. Recognised forms:
 *   - Named keys:      "Enter", "Tab", "Escape", "Up", "F5", "Backspace", ...
 *   - Control chords:  "C-c", "Ctrl-x", "^d", "control-["   -> a single 0x00..0x1f/0x7f byte
 *   - Alt/Meta chords: "M-b", "Alt-f", "meta-."             -> ESC-prefixed byte
 *   - Raw hex:         "hex:1b5b41"                          -> arbitrary bytes
 *   - A single character is sent as-is (e.g. "y", "Q").
 *
 * Any other multi-character token is an error: silently typing a typo'd
 * chord (e.g. "ctrl+c") into a live remote shell is far worse than failing
 * the call. Literal text belongs in `text`, not `keys`.
 */

const ESC = "\x1b";

/** Named keys mapped to the byte sequence xterm-style terminals expect. */
const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  ret: "\r",
  newline: "\n",
  lf: "\n",
  cr: "\r",
  tab: "\t",
  backtab: `${ESC}[Z`,
  space: " ",
  escape: ESC,
  esc: ESC,
  backspace: "\x7f",
  bs: "\x7f",
  delete: `${ESC}[3~`,
  del: `${ESC}[3~`,
  insert: `${ESC}[2~`,
  ins: `${ESC}[2~`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  pgup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  pgdn: `${ESC}[6~`,
  f1: `${ESC}OP`,
  f2: `${ESC}OQ`,
  f3: `${ESC}OR`,
  f4: `${ESC}OS`,
  f5: `${ESC}[15~`,
  f6: `${ESC}[17~`,
  f7: `${ESC}[18~`,
  f8: `${ESC}[19~`,
  f9: `${ESC}[20~`,
  f10: `${ESC}[21~`,
  f11: `${ESC}[23~`,
  f12: `${ESC}[24~`,
  nul: "\x00",
  null: "\x00",
};

/**
 * Cursor/keypad keys switch to SS3 sequences when the remote app enables
 * DECCKM (application cursor-keys mode), the way a real terminal does.
 */
const APP_CURSOR_KEYS: Record<string, string> = {
  up: `${ESC}OA`,
  down: `${ESC}OB`,
  right: `${ESC}OC`,
  left: `${ESC}OD`,
  home: `${ESC}OH`,
  end: `${ESC}OF`,
};

export interface KeyOptions {
  /** Emit SS3 cursor-key sequences (remote app has DECCKM enabled). */
  applicationCursorKeys?: boolean;
}

/**
 * Map a single control-chord target character to its control byte.
 * Ctrl-A..Ctrl-Z -> 0x01..0x1a, plus the C0 punctuation chords.
 */
function controlByte(ch: string): string | undefined {
  if (ch.length !== 1) return undefined;
  const c = ch.toLowerCase();
  if (c >= "a" && c <= "z") {
    return String.fromCharCode(c.charCodeAt(0) - 96); // 'a'->1 ... 'z'->26
  }
  // C0 control punctuation, matching what a real terminal produces.
  const punct: Record<string, number> = {
    "@": 0,
    " ": 0,
    "[": 27,
    "\\": 28,
    "]": 29,
    "^": 30,
    "_": 31,
    "?": 127,
  };
  if (ch in punct) return String.fromCharCode(punct[ch]);
  return undefined;
}

function parseHex(spec: string): string {
  const hex = spec.replace(/[\s:]/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`Invalid hex key token "hex:${spec}"`);
  }
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Resolve a single key token to its byte sequence. Throws on a malformed
 * control/alt/hex chord — or any unrecognised multi-character token — so the
 * caller gets a clear error instead of silently sending the wrong bytes.
 */
export function resolveKey(token: string, opts: KeyOptions = {}): string {
  if (token.length === 0) return "";

  const lower = token.toLowerCase();
  if (opts.applicationCursorKeys && lower in APP_CURSOR_KEYS) return APP_CURSOR_KEYS[lower];
  if (lower in NAMED_KEYS) return NAMED_KEYS[lower];

  if (lower.startsWith("hex:")) return parseHex(token.slice(4));

  // Control chord: "C-x", "Ctrl-x", "control-x", "^x"
  const m = /^(?:c|ctrl|control)-(.+)$/i.exec(token);
  const caretTarget = !m && token.length === 2 && token[0] === "^" ? token.slice(1) : undefined;
  if (m || caretTarget !== undefined) {
    const target = m ? m[1] : (caretTarget as string);
    // Allow a named key as the chord target (e.g. "C-Space").
    const namedTarget = target.toLowerCase();
    const base = namedTarget in NAMED_KEYS ? NAMED_KEYS[namedTarget] : target;
    const cb = controlByte(base.length === 1 ? base : target);
    if (cb === undefined) throw new Error(`Unsupported control chord "${token}"`);
    return cb;
  }

  // Alt / Meta chord: "M-b", "Alt-f", "meta-." -> ESC followed by the target.
  const alt = /^(?:m|alt|meta)-(.+)$/i.exec(token);
  if (alt) {
    const target = alt[1];
    const resolvedTarget = resolveKey(target, opts); // supports Alt+named/control targets
    return ESC + resolvedTarget;
  }

  // A single character is a literal keypress. Count code points, not UTF-16
  // units, so an astral-plane character (e.g. an emoji) still counts as one.
  if ([...token].length === 1) return token;

  throw new Error(
    `Unrecognised key token "${token}". Use a named key (Enter, Tab, Up, F5, ...), ` +
      `a chord ("C-x", "M-b"), "hex:..", a single character, or put literal text in \`text\`.`
  );
}

/** Resolve an ordered list of key tokens to one concatenated byte string. */
export function resolveKeys(tokens: string[], opts: KeyOptions = {}): string {
  return tokens.map((t) => resolveKey(t, opts)).join("");
}
