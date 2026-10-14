import { emojiRegex } from "@misskey-dev/emoji-data";
//#region src/node.ts
const blockTypes = /* @__PURE__ */ new Set([
	"quote",
	"search",
	"blockCode",
	"mathBlock",
	"center"
]);
function isMfmBlock(node) {
	return blockTypes.has(node.type);
}
const QUOTE = (children) => {
	return {
		type: "quote",
		children
	};
};
const SEARCH = (query, content) => {
	return {
		type: "search",
		props: {
			query,
			content
		}
	};
};
const CODE_BLOCK = (code, lang) => {
	return {
		type: "blockCode",
		props: {
			code,
			lang
		}
	};
};
const MATH_BLOCK = (formula) => {
	return {
		type: "mathBlock",
		props: { formula }
	};
};
const CENTER = (children) => {
	return {
		type: "center",
		children
	};
};
const UNI_EMOJI = (value) => {
	return {
		type: "unicodeEmoji",
		props: { emoji: value }
	};
};
const EMOJI_CODE = (name) => {
	return {
		type: "emojiCode",
		props: { name }
	};
};
const BOLD = (children) => {
	return {
		type: "bold",
		children
	};
};
const SMALL = (children) => {
	return {
		type: "small",
		children
	};
};
const ITALIC = (children) => {
	return {
		type: "italic",
		children
	};
};
const STRIKE = (children) => {
	return {
		type: "strike",
		children
	};
};
const INLINE_CODE = (code) => {
	return {
		type: "inlineCode",
		props: { code }
	};
};
const MATH_INLINE = (formula) => {
	return {
		type: "mathInline",
		props: { formula }
	};
};
const MENTION = (username, host, acct) => {
	return {
		type: "mention",
		props: {
			username,
			host,
			acct
		}
	};
};
const HASHTAG = (value) => {
	return {
		type: "hashtag",
		props: { hashtag: value }
	};
};
const N_URL = (value, brackets) => {
	const node = {
		type: "url",
		props: { url: value }
	};
	if (brackets) node.props.brackets = brackets;
	return node;
};
const LINK = (silent, url, children) => {
	return {
		type: "link",
		props: {
			silent,
			url
		},
		children
	};
};
const FN = (name, args, children) => {
	return {
		type: "fn",
		props: {
			name,
			args
		},
		children
	};
};
const PLAIN = (text) => {
	return {
		type: "plain",
		children: [TEXT(text)]
	};
};
const TEXT = (value) => {
	return {
		type: "text",
		props: { text: value }
	};
};
//#endregion
//#region src/internal/parser.ts
const EMOJI_RE = new RegExp(emojiRegex.source, "y");
const EMOJI_UNITS = collectRegexCodeUnits(emojiRegex);
/** 1 なら emojiRegex が一致し得る文字。列挙できない構成の正規表現なら全ての文字で試す。 */
const EMOJI_UNIT = (/* @__PURE__ */ new Uint8Array(65536)).fill(EMOJI_UNITS == null ? 1 : 0);
/** 1 ならどの構文も始まり得ない文字。絵文字を列挙できなければ表引きを使わない。 */
const PLAIN$1 = (/* @__PURE__ */ new Uint8Array(65536)).fill(EMOJI_UNITS == null ? 0 : 1);
if (EMOJI_UNITS != null) {
	for (const unit of EMOJI_UNITS) {
		EMOJI_UNIT[unit] = 1;
		PLAIN$1[unit] = 0;
	}
	for (const char of "\r\n<>*_`\\~$@#:?[h") PLAIN$1[char.charCodeAt(0)] = 0;
}
function collectRegexCodeUnits(pattern) {
	if (/[iuv]/.test(pattern.flags)) return null;
	const source = pattern.source;
	const units = /* @__PURE__ */ new Set();
	let inClass = false;
	let rangeFrom = null;
	let previous = null;
	const add = (unit) => {
		if (rangeFrom != null) {
			for (let u = rangeFrom; u <= unit; u++) units.add(u);
			rangeFrom = null;
		} else units.add(unit);
		previous = unit;
	};
	for (let i = 0; i < source.length; i++) {
		const char = source.charAt(i);
		if (char === "\\") {
			const next = source[i + 1];
			if (next === "u") {
				add(Number.parseInt(source.slice(i + 2, i + 6), 16));
				i += 5;
				continue;
			}
			if (next == null || /[dDwWsSpPbBkcx0-9]/.test(next)) return null;
			add(next.charCodeAt(0));
			i++;
			continue;
		}
		if (inClass) {
			if (char === "]") {
				inClass = false;
				previous = null;
				continue;
			}
			if (char === "-" && previous != null && source[i + 1] !== "]") {
				rangeFrom = previous;
				continue;
			}
			add(char.charCodeAt(0));
			continue;
		}
		if (char === "[") {
			if (source[i + 1] === "^") return null;
			inClass = true;
			previous = null;
			continue;
		}
		if (char === ".") return null;
		add(char.charCodeAt(0));
	}
	return units;
}
let S = "";
let L = 0;
let depth = 0;
let nestLimit = 20;
let linkLabel = false;
let out = "";
const newRecords = () => ({
	failures: null,
	lf: {
		from: 0,
		at: -1
	},
	cr: {
		from: 0,
		at: -1
	},
	founds: null
});
/**
* 引用の中身の記録。同じ内容の引用は同じ記録を使う。文字列をキーに引くと、別に作られた同じ内容の文字列とは
* 全文を比べることになるので、引くのは引用に入るときだけにし、それ以外は current を使う。
*/
let quoteRecords = null;
/** 今の S の記録。最上位の入力では、初めて使うときに作る。 */
let current = null;
function setInput(input, inputRecords) {
	S = input;
	L = input.length;
	current = inputRecords;
}
function currentRecords() {
	current ??= newRecords();
	return current;
}
function recordsOfQuote(content) {
	quoteRecords ??= /* @__PURE__ */ new Map();
	let inputRecords = quoteRecords.get(content);
	if (inputRecords == null) {
		inputRecords = newRecords();
		quoteRecords.set(content, inputRecords);
	}
	return inputRecords;
}
/**
* 本文ループで読んだ結果を、隣り合う text を結合しながら積む。
* text になる文字列は読んだ範囲そのもので、本文ループは位置を進めながら積むため、結合する文字列は入力の中で隣り合う。
* そのため範囲だけを覚え、ノードの手前で 1 回だけ切り出す。
*/
var Acc = class {
	nodes = [];
	start = 0;
	end = 0;
	has = false;
	/** [from, to) を読んだ結果 value を積む。value が文字列なら S.slice(from, to) と同じ。 */
	push(from, to, value) {
		if (typeof value === "string") {
			if (!this.has) {
				this.start = from;
				this.has = true;
			}
			this.end = to;
		} else {
			this.flush();
			this.nodes.push(value);
		}
	}
	flush() {
		if (this.has) {
			this.nodes.push(TEXT(S.slice(this.start, this.end)));
			this.has = false;
		}
	}
	/** S が積んだときと同じ文字列の間に呼ぶ。 */
	done() {
		this.flush();
		return this.nodes;
	}
};
const LF = 10;
const CR = 13;
/** i にある改行の長さ (\r\n は 2)。改行でなければ 0。 */
function newLine(i) {
	if (i >= L) return 0;
	const c = S.charCodeAt(i);
	if (c === CR) return S.charCodeAt(i + 1) === LF ? 2 : 1;
	return c === LF ? 1 : 0;
}
function lineBegin(i) {
	if (i === 0) return true;
	const c = S.charCodeAt(i - 1);
	return c === LF || c === CR;
}
function lineEnd(i) {
	if (i === L) return true;
	const c = S.charCodeAt(i);
	return c === LF || c === CR;
}
const isSpace = (c) => c === 32 || c === 12288 || c === 9;
const isAlnum = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
/** [a-z0-9_]、大文字小文字を区別しない */
const isNameChar = (c) => isAlnum(c) || c === 95;
/** [a-z0-9_.-]、大文字小文字を区別しない */
const isHostChar = (c) => isAlnum(c) || c === 95 || c === 46 || c === 45;
const isDotOrDash = (c) => c === 46 || c === 45;
/** 直前の 1 文字が英数字か。直前を見る構文は、英単語の途中では成立しない。 */
const prevAlnum = (i) => i > 0 && isAlnum(S.charCodeAt(i - 1));
const SCAN_MATH_BLOCK = 0;
const SCAN_CENTER = 1;
const SCAN_PLAIN = 2;
const SCAN_MATH_INLINE = 3;
const SCAN_LINK = 4;
const SCAN_URL_ALT = 5;
const SCAN_KINDS = 6;
/** 今の深さとリンクラベル内外での、本文ループ kind の記録の番号。 */
function scanSlot(kind) {
	return (depth * 2 + (linkLabel ? 1 : 0)) * SCAN_KINDS + kind;
}
/** 記録した失敗位置。たいていの入力は一度も失敗を記録しないので、記録するまで入れ物を作らず undefined を返す。 */
function scanFailed(slot) {
	return currentRecords().failures?.get(slot);
}
function scanFailedForWrite(slot) {
	const inputRecords = currentRecords();
	inputRecords.failures ??= /* @__PURE__ */ new Map();
	let failed = inputRecords.failures.get(slot);
	if (failed == null) {
		failed = /* @__PURE__ */ new Set();
		inputRecords.failures.set(slot, failed);
	}
	return failed;
}
/**
* 1 文字ずつ読む本文ループ。start から stop(p) が真になる位置まで読み、1 文字以上あれば tail で閉じ記号を読む。
* 成功したら閉じの後の位置を返す。本文の終わりは stop が真になった最初の位置。
*/
function scanChars(start, kind, stop, tail) {
	const slot = scanSlot(kind);
	const failed = scanFailed(slot);
	let p = start;
	while (p < L) {
		if (failed?.has(p)) return markFailed(slot, start, p);
		if (stop(p)) break;
		p++;
	}
	if (p >= L && failed?.has(p)) return markFailed(slot, start, p);
	if (p === start) return -1;
	const end = tail(p);
	if (end < 0) return markFailed(slot, start, p + 1);
	return end;
}
/** [from, to) を失敗位置として覚え、-1 を返す。 */
function markFailed(slot, from, to) {
	const failed = scanFailedForWrite(slot);
	for (let p = from; p < to; p++) failed.add(p);
	return -1;
}
/** 試行が通った位置を失敗位置として覚え、-1 を返す。 */
function markVisitedFailed(slot, visited) {
	const failed = scanFailedForWrite(slot);
	for (const p of visited) failed.add(p);
	return -1;
}
/** q 以降で最初に key が現れる位置 (無ければ L)。find を渡すと、key は名前として使い find で探す。 */
function findFrom(key, q, find) {
	const inputRecords = currentRecords();
	inputRecords.founds ??= /* @__PURE__ */ new Map();
	let found = inputRecords.founds.get(key);
	if (found == null) {
		found = {
			from: 0,
			at: -1
		};
		inputRecords.founds.set(key, found);
	}
	return findWith(found, q, key, find);
}
/** found が q を含む範囲を覚えていればそれを、無ければ探して覚え直した位置を返す。find が無ければ needle を探す。 */
function findWith(found, q, needle, find) {
	if (found.from <= q && q <= found.at) return found.at;
	let at;
	if (find != null) at = find(q);
	else {
		at = S.indexOf(needle, q);
		if (at < 0) at = L;
	}
	found.from = q;
	found.at = at;
	return at;
}
/** 入れ子の上限内なら inline を、超えたら 1 文字を読む。 */
function nestInline(p) {
	depth++;
	let end;
	if (depth < nestLimit) end = inline(p);
	else {
		out = S.charAt(p);
		end = p + 1;
	}
	depth--;
	return end;
}
const CLOSE_BRACKET = 93;
function plainRun(i) {
	let end = i + 1;
	while (end < L) {
		const c = S.charCodeAt(end);
		if (PLAIN$1[c] !== 1 || c === CLOSE_BRACKET) break;
		end++;
	}
	out = S.slice(i, end);
	return end;
}
function full(i) {
	const c = S.charCodeAt(i);
	const atLineBegin = lineBegin(i);
	if (!atLineBegin && PLAIN$1[c] === 1) return plainRun(i);
	const isNewLine = c === LF || c === CR;
	let end;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if ((isNewLine || c === 60) && (end = centerTag(i)) >= 0) return end;
	if ((end = inlineMarks(i, c)) >= 0) return end;
	if ((isNewLine || c === 96) && (end = codeBlock(i)) >= 0) return end;
	if (c === 96 && (end = inlineCode(i)) >= 0) return end;
	if ((isNewLine || c === 62) && (end = quote(i)) >= 0) return end;
	if ((isNewLine || c === 92) && (end = mathBlock(i)) >= 0) return end;
	if (c === 92 && (end = mathInline(i)) >= 0) return end;
	if ((end = inlineTail(i, c)) >= 0) return end;
	if ((isNewLine || atLineBegin) && (end = search(i)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}
function inline(i) {
	const c = S.charCodeAt(i);
	if (!lineBegin(i) && PLAIN$1[c] === 1) return plainRun(i);
	let end;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if ((end = inlineMarks(i, c)) >= 0) return end;
	if (c === 96 && (end = inlineCode(i)) >= 0) return end;
	if (c === 92 && (end = mathInline(i)) >= 0) return end;
	if ((end = inlineTail(i, c)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}
function simple(i) {
	const c = S.charCodeAt(i);
	if (!lineBegin(i) && PLAIN$1[c] === 1) return plainRun(i);
	let end;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if (c === 58 && (end = emojiCode(i)) >= 0) return end;
	if (c === 60 && (end = plainTag(i)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}
/** smallTag, plainTag, boldTag, italicTag, strikeTag, urlAlt, big, boldAsta, italicAsta, boldUnder, italicUnder の順 */
function inlineMarks(i, c) {
	let end;
	switch (c) {
		case 60:
			if ((end = wrap(i, "<small>", "</small>", SMALL)) >= 0) return end;
			if ((end = plainTag(i)) >= 0) return end;
			if ((end = wrap(i, "<b>", "</b>", BOLD)) >= 0) return end;
			if ((end = wrap(i, "<i>", "</i>", ITALIC)) >= 0) return end;
			if ((end = wrap(i, "<s>", "</s>", STRIKE)) >= 0) return end;
			return urlAlt(i);
		case 42:
			if ((end = wrap(i, "***", "***", tada)) >= 0) return end;
			if ((end = wrap(i, "**", "**", BOLD)) >= 0) return end;
			return italicMark(i, 42);
		case 95:
			if ((end = boldUnder(i)) >= 0) return end;
			return italicMark(i, 95);
	}
	return -1;
}
/** strikeWave, fn, mention, hashtag, emojiCode, link, url (先頭の文字がそれぞれ異なる) */
function inlineTail(i, c) {
	switch (c) {
		case 126: return wrap(i, "~~", "~~", STRIKE);
		case 36: return fn(i);
		case 64: return mention(i);
		case 35: return hashtag(i);
		case 58: return emojiCode(i);
		case 63:
		case 91: return link(i);
		case 104: return url(i);
	}
	return -1;
}
const tada = (children) => FN("tada", {}, children);
/**
* open の後、close の手前まで inline を 1 つ以上読み、close で閉じる。
* open の直後が close なら open だけを、閉じられなければ読んだ範囲全体を text にする。~~ は改行の手前でも止まる。
*/
function wrap(i, open, close, node) {
	if (!S.startsWith(open, i)) return -1;
	const stopAtNewLine = close === "~~";
	const bodyStart = i + open.length;
	const acc = new Acc();
	let p = bodyStart;
	if (depth + 1 >= nestLimit && p < L) {
		let end = findFrom(close, p);
		if (stopAtNewLine) end = Math.min(end, lineEndFrom(p));
		if (end > p) {
			acc.push(p, end, "");
			p = end;
		}
	}
	while (p < L) {
		if (S.startsWith(close, p) || stopAtNewLine && newLine(p) > 0) break;
		const from = p;
		p = nestInline(p);
		acc.push(from, p, out);
	}
	if (p === bodyStart) {
		out = open;
		return bodyStart;
	}
	if (!S.startsWith(close, p)) {
		out = S.slice(i, p);
		return p;
	}
	out = node(acc.done());
	return p + close.length;
}
/** 英数字と空白だけの本文を読む (__ と _ と * の強調)。 */
function alnumSpaceRun(p) {
	while (p < L) {
		const c = S.charCodeAt(p);
		if (!isAlnum(c) && !isSpace(c)) break;
		p++;
	}
	return p;
}
function boldUnder(i) {
	if (!S.startsWith("__", i)) return -1;
	const p = alnumSpaceRun(i + 2);
	if (p === i + 2 || !S.startsWith("__", p)) return -1;
	out = BOLD([TEXT(S.slice(i + 2, p))]);
	return p + 2;
}
function italicMark(i, mark) {
	if (S.charCodeAt(i) !== mark) return -1;
	const p = alnumSpaceRun(i + 1);
	if (p === i + 1 || S.charCodeAt(p) !== mark || prevAlnum(i)) return -1;
	out = ITALIC([TEXT(S.slice(i + 1, p))]);
	return p + 1;
}
function quote(i) {
	let q = i;
	q += newLine(q);
	q += newLine(q);
	if (!lineBegin(q) || S.charCodeAt(q) !== 62) return -1;
	const lines = [];
	let p = quoteLine(q, lines);
	while (p < L) {
		const n = newLine(p);
		if (n === 0 || S.charCodeAt(p + n) !== 62) break;
		p = quoteLine(p + n, lines);
	}
	p += newLine(p);
	p += newLine(p);
	if (lines.length === 1 && lines[0] === "") return -1;
	const outer = S;
	const outerRecords = current;
	const content = lines.join("\n");
	setInput(content, recordsOfQuote(content));
	const acc = new Acc();
	depth++;
	if (depth < nestLimit) {
		let k = 0;
		while (k < L) {
			const from = k;
			k = full(k);
			acc.push(from, k, out);
		}
	} else acc.push(0, L, S);
	depth--;
	const children = acc.done();
	setInput(outer, outerRecords);
	out = QUOTE(children);
	return p;
}
/** > と続く空白 1 つの後、行末までを中身とする。 */
function quoteLine(p, lines) {
	p++;
	if (p < L && isSpace(S.charCodeAt(p))) p++;
	const start = p;
	while (p < L && newLine(p) === 0) p++;
	lines.push(S.slice(start, p));
	return p;
}
/** 改行・```・行末の並び。コードブロックの本文はこの手前で終わる。 */
function codeBlockCloseAt(p) {
	const n = newLine(p);
	return n > 0 && S.startsWith("```", p + n) && lineEnd(p + n + 3);
}
function codeBlockCloseFrom(q) {
	let p = q;
	while (p < L && !codeBlockCloseAt(p)) p++;
	return p;
}
function codeBlock(i) {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith("```", q)) return -1;
	q += 3;
	const langStart = q;
	while (q < L && newLine(q) === 0) q++;
	const lang = S.slice(langStart, q).trim();
	const n = newLine(q);
	if (n === 0) return -1;
	q += n;
	const codeStart = q;
	const p = findFrom("codeBlockClose", q, codeBlockCloseFrom);
	if (p === codeStart || p >= L) return -1;
	let end = p + newLine(p) + 3;
	end += newLine(end);
	out = CODE_BLOCK(S.slice(codeStart, p), lang.length > 0 ? lang : null);
	return end;
}
/** 改行 1 つを挟んでよい閉じ記号の後が行末なら、その後 (改行 1 つまで含む) の位置。 */
function blockClose(p, close) {
	let q = p + newLine(p);
	if (!S.startsWith(close, q)) return -1;
	q += close.length;
	if (!lineEnd(q)) return -1;
	return q + newLine(q);
}
const stopMathBlock = (p) => S.startsWith("\\]", p + newLine(p));
const closeMathBlock = (p) => blockClose(p, "\\]");
function mathBlock(i) {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith("\\[", q)) return -1;
	q += 2;
	q += newLine(q);
	const start = q;
	const end = scanChars(start, SCAN_MATH_BLOCK, stopMathBlock, closeMathBlock);
	if (end < 0) return -1;
	let p = start;
	while (!stopMathBlock(p)) p++;
	out = MATH_BLOCK(S.slice(start, p));
	return end;
}
function centerTag(i) {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith("<center>", q)) return -1;
	q += 8;
	q += newLine(q);
	const slot = scanSlot(SCAN_CENTER);
	const failed = scanFailed(slot);
	const visited = [];
	const acc = new Acc();
	let p = q;
	let stopped = false;
	while (p < L) {
		if (failed?.has(p)) {
			stopped = true;
			break;
		}
		visited.push(p);
		if (S.startsWith("</center>", p + newLine(p))) break;
		const from = p;
		p = nestInline(p);
		acc.push(from, p, out);
	}
	if (!stopped && p >= L && failed?.has(p)) stopped = true;
	if (!stopped && p === q) return -1;
	let end = -1;
	if (!stopped) {
		visited.push(p);
		end = blockClose(p, "</center>");
	}
	if (end < 0) return markVisitedFailed(slot, visited);
	out = CENTER(acc.done());
	return end;
}
const stopPlain = (p) => S.startsWith("</plain>", p + newLine(p));
function closePlain(p) {
	const q = p + newLine(p);
	return S.startsWith("</plain>", q) ? q + 8 : -1;
}
function plainTag(i) {
	if (!S.startsWith("<plain>", i)) return -1;
	let q = i + 7;
	q += newLine(q);
	const start = q;
	const end = scanChars(start, SCAN_PLAIN, stopPlain, closePlain);
	if (end < 0) return -1;
	let p = start;
	while (!stopPlain(p)) p++;
	out = PLAIN(S.slice(start, p));
	return end;
}
function inlineCode(i) {
	let p = i + 1;
	while (p < L) {
		const c = S.charCodeAt(p);
		if (c === 96 || c === 180 || c === LF || c === CR) break;
		p++;
	}
	if (p === i + 1 || S.charCodeAt(p) !== 96) return -1;
	out = INLINE_CODE(S.slice(i + 1, p));
	return p + 1;
}
const stopMathInline = (p) => S.startsWith("\\)", p) || newLine(p) > 0;
const closeMathInline = (p) => S.startsWith("\\)", p) ? p + 2 : -1;
function mathInline(i) {
	if (!S.startsWith("\\(", i)) return -1;
	const start = i + 2;
	const end = scanChars(start, SCAN_MATH_INLINE, stopMathInline, closeMathInline);
	if (end < 0) return -1;
	out = MATH_INLINE(S.slice(start, end - 2));
	return end;
}
function unicodeEmoji(i) {
	EMOJI_RE.lastIndex = i;
	const match = EMOJI_RE.exec(S);
	if (match == null) return -1;
	const content = match[0];
	out = content === "️" ? content : UNI_EMOJI(content);
	return i + content.length;
}
function emojiCode(i) {
	let p = i + 1;
	while (p < L) {
		const c = S.charCodeAt(p);
		if (!isNameChar(c) && c !== 43 && c !== 45) break;
		p++;
	}
	if (p === i + 1 || S.charCodeAt(p) !== 58) return -1;
	const end = p + 1;
	if (end < L && isAlnum(S.charCodeAt(end))) return -1;
	out = EMOJI_CODE(S.slice(i + 1, p));
	return end;
}
/** $[name.k=v,k2 本文]。名前・引数・空白・本文・] のどこかで失敗したら、そこまでを text にする。 */
function fn(i) {
	if (!S.startsWith("$[", i)) return -1;
	let p = i + 2;
	const nameStart = p;
	while (p < L && isNameChar(S.charCodeAt(p))) p++;
	if (p === nameStart) {
		out = S.slice(i, p);
		return p;
	}
	const name = S.slice(nameStart, p);
	const args = {};
	if (S.charCodeAt(p) === 46) {
		const pairs = [];
		let q = fnArg(p + 1, pairs);
		if (q >= 0) {
			while (q < L && S.charCodeAt(q) === 44) {
				const next = fnArg(q + 1, pairs);
				if (next < 0) break;
				q = next;
			}
			for (const [key, value] of pairs) args[key] = value;
			p = q;
		}
	}
	if (S.charCodeAt(p) !== 32) {
		out = S.slice(i, p);
		return p;
	}
	p++;
	const bodyStart = p;
	const acc = new Acc();
	if (depth + 1 >= nestLimit && p < L) {
		const end = findFrom("]", p);
		if (end > p) {
			acc.push(p, end, "");
			p = end;
		}
	}
	while (p < L && S.charCodeAt(p) !== CLOSE_BRACKET) {
		const from = p;
		p = nestInline(p);
		acc.push(from, p, out);
	}
	if (p === bodyStart || S.charCodeAt(p) !== CLOSE_BRACKET) {
		out = S.slice(i, p);
		return p;
	}
	out = FN(name, args, acc.done());
	return p + 1;
}
/** 引数 1 つ (key か key=value) を読む。= の後に値が無ければ = を読まず key だけにする。 */
function fnArg(p, pairs) {
	const keyStart = p;
	while (p < L && isNameChar(S.charCodeAt(p))) p++;
	if (p === keyStart) return -1;
	const key = S.slice(keyStart, p);
	let value = true;
	if (S.charCodeAt(p) === 61) {
		const valueStart = p + 1;
		let q = valueStart;
		while (q < L && isHostChar(S.charCodeAt(q))) q++;
		if (q > valueStart) {
			value = S.slice(valueStart, q);
			p = q;
		}
	}
	pairs.push([key, value]);
	return p;
}
/** 末尾の . と - の数 */
function trailingDotsOrDashes(value) {
	let n = value.length;
	while (n > 0 && isDotOrDash(value.charCodeAt(n - 1))) n--;
	return value.length - n;
}
function mention(i) {
	if (linkLabel) return -1;
	let p = i + 1;
	while (p < L && isHostChar(S.charCodeAt(p))) p++;
	if (p === i + 1) return -1;
	const username = S.slice(i + 1, p);
	let hostname = null;
	if (S.charCodeAt(p) === 64) {
		let q = p + 1;
		while (q < L && isHostChar(S.charCodeAt(q))) q++;
		if (q > p + 1) {
			hostname = S.slice(p + 1, q);
			p = q;
		}
	}
	if (prevAlnum(i)) return -1;
	const resultIndex = p;
	let invalid = false;
	let host = hostname;
	if (hostname != null) {
		const trailing = trailingDotsOrDashes(hostname);
		if (trailing > 0) {
			host = hostname.slice(0, -trailing);
			if (host.length === 0) {
				invalid = true;
				host = null;
			}
		}
	}
	let name = username;
	const trailing = trailingDotsOrDashes(username);
	if (trailing > 0) {
		if (host == null) name = username.slice(0, -trailing);
		else invalid = true;
	}
	if (name.length === 0 || isDotOrDash(name.charCodeAt(0))) invalid = true;
	if (host != null && isDotOrDash(host.charCodeAt(0))) invalid = true;
	if (invalid) {
		out = S.slice(i, resultIndex);
		return resultIndex;
	}
	const acct = host != null ? `@${name}@${host}` : `@${name}`;
	out = MENTION(name, host, acct);
	return i + acct.length;
}
/** ハッシュタグに使えない文字: 空白・改行・句読点・引用符・括弧類 */
function isHashtagChar(c) {
	switch (c) {
		case 32:
		case 12288:
		case 9:
		case LF:
		case CR:
		case 46:
		case 44:
		case 33:
		case 63:
		case 39:
		case 34:
		case 35:
		case 58:
		case 47:
		case 91:
		case 93:
		case 12304:
		case 12305:
		case 40:
		case 41:
		case 12300:
		case 12301:
		case 65288:
		case 65289:
		case 60:
		case 62: return false;
	}
	return true;
}
/** [.,a-z0-9_/:%#@$&?!~=+-]、大文字小文字を区別しない */
const URL_CHAR = /* @__PURE__ */ new Uint8Array(128);
for (const char of ".,_/:%#@$&?!~=+-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") URL_CHAR[char.charCodeAt(0)] = 1;
const isUrlChar = (c) => URL_CHAR[c] === 1;
/** ハッシュタグか URL の本文の 1 要素。括弧は対応する閉じ括弧があるときだけ中身ごと読み、入れ子の上限を超えたら文字だけを読む。 */
function bracketedItem(p, isUrl) {
	const c = S.charCodeAt(p);
	let closer = -1;
	if (c === 40) closer = 41;
	else if (c === 91) closer = 93;
	else if (!isUrl && c === 12300) closer = 12301;
	else if (!isUrl && c === 65288) closer = 65289;
	if (closer < 0) return (isUrl ? isUrlChar(c) : isHashtagChar(c)) ? p + 1 : -1;
	let q = p + 1;
	while (q < L) {
		depth++;
		let next;
		if (depth < nestLimit) next = bracketedItem(q, isUrl);
		else {
			const d = S.charCodeAt(q);
			next = (isUrl ? isUrlChar(d) : isHashtagChar(d)) ? q + 1 : -1;
		}
		depth--;
		if (next < 0) break;
		q = next;
	}
	return S.charCodeAt(q) === closer ? q + 1 : -1;
}
function hashtag(i) {
	if (linkLabel) return -1;
	let p = i + 1;
	let next;
	while (p < L && (next = bracketedItem(p, false)) >= 0) p = next;
	if (p === i + 1 || prevAlnum(i)) return -1;
	const value = S.slice(i + 1, p);
	if (/^[0-9]+$/.test(value)) return -1;
	out = HASHTAG(value);
	return p;
}
/** http:// か https:// の長さ。どちらでもなければ 0。 */
function schemeLength(i) {
	if (!S.startsWith("http", i)) return 0;
	let p = i + 4;
	if (S.charCodeAt(p) === 115) p++;
	return S.startsWith("://", p) ? p + 3 - i : 0;
}
function url(i) {
	if (linkLabel) return -1;
	const scheme = schemeLength(i);
	if (scheme === 0) return -1;
	const start = i + scheme;
	let p = start;
	let next;
	while (p < L && (next = bracketedItem(p, true)) >= 0) p = next;
	if (p === start) return -1;
	let end = p;
	while (end > start) {
		const c = S.charCodeAt(end - 1);
		if (c !== 46 && c !== 44) break;
		end--;
	}
	if (end === start) {
		out = S.slice(i, p);
		return p;
	}
	out = N_URL(S.slice(i, end), false);
	return end;
}
const stopUrlAlt = (p) => {
	const c = S.charCodeAt(p);
	return c === 62 || isSpace(c);
};
const closeUrlAlt = (p) => S.charCodeAt(p) === 62 ? p + 1 : -1;
function urlAlt(i) {
	if (linkLabel) return -1;
	const scheme = schemeLength(i + 1);
	if (scheme === 0) return -1;
	const end = scanChars(i + 1 + scheme, SCAN_URL_ALT, stopUrlAlt, closeUrlAlt);
	if (end < 0) return -1;
	out = N_URL(S.slice(i + 1, end - 1), true);
	return end;
}
/** [ラベル](url) と ?[ラベル](url)。ラベルの中ではリンク・メンション・ハッシュタグ・URL を読まない。 */
function link(i) {
	if (linkLabel) return -1;
	let silent;
	if (S.startsWith("?[", i)) silent = true;
	else if (S.charCodeAt(i) === 91) silent = false;
	else return -1;
	const labelStart = i + (silent ? 2 : 1);
	const slot = scanSlot(SCAN_LINK);
	const failed = scanFailed(slot);
	const visited = [];
	const acc = new Acc();
	let p = labelStart;
	let stopped = false;
	while (p < L) {
		if (failed?.has(p)) {
			stopped = true;
			break;
		}
		visited.push(p);
		const c = S.charCodeAt(p);
		if (c === CLOSE_BRACKET || c === LF || c === CR) break;
		const from = p;
		depth++;
		if (depth < nestLimit) {
			linkLabel = true;
			p = inline(p);
			linkLabel = false;
		} else {
			out = S.charAt(p);
			p++;
		}
		depth--;
		acc.push(from, p, out);
	}
	if (!stopped && p >= L && failed?.has(p)) stopped = true;
	if (!stopped && p === labelStart) return -1;
	let end = -1;
	let target = null;
	if (!stopped) {
		visited.push(p);
		if (S.charCodeAt(p) === CLOSE_BRACKET && S.charCodeAt(p + 1) === 40) {
			let urlEnd = urlAlt(p + 2);
			if (urlEnd < 0) urlEnd = url(p + 2);
			if (urlEnd >= 0 && typeof out !== "string" && S.charCodeAt(urlEnd) === 41) {
				target = out;
				end = urlEnd + 1;
			}
		}
	}
	if (target == null) return markVisitedFailed(slot, visited);
	out = LINK(silent, target.props.url, acc.done());
	return end;
}
/** 検索ボタン ([検索] / [search] / 検索 / search、search は大文字小文字を区別しない) の長さ。無ければ -1。 */
function searchButton(p) {
	if (S.charCodeAt(p) === 91) {
		if (S.startsWith("検索]", p + 1)) return 4;
		if (isSearchWord(p + 1) && S.charCodeAt(p + 7) === CLOSE_BRACKET) return 8;
		return -1;
	}
	if (S.startsWith("検索", p)) return 2;
	if (isSearchWord(p)) return 6;
	return -1;
}
/** search を ASCII の英字だけ大文字小文字を区別せずに比べる (正規表現の i フラグと同じ) */
function isSearchWord(p) {
	if (p + 6 > L) return false;
	for (let k = 0; k < 6; k++) {
		const c = S.charCodeAt(p + k);
		if ((c >= 65 && c <= 90 ? c + 32 : c) !== "search".charCodeAt(k)) return false;
	}
	return true;
}
/** q 以降で最初の改行 (\r か \n) の位置。無ければ L。 */
function lineEndFrom(q) {
	const inputRecords = currentRecords();
	return Math.min(findWith(inputRecords.lf, q, "\n"), findWith(inputRecords.cr, q, "\r"));
}
/** 行 [start, end) が「空白 検索ボタン」で終わるか。検索構文が成立する行の必要条件。 */
function endsWithSearchButton(start, end) {
	let button = -1;
	if (S.charCodeAt(end - 1) === CLOSE_BRACKET) {
		if (end - 4 > start && searchButton(end - 4) === 4) button = 4;
		else if (end - 8 > start && searchButton(end - 8) === 8) button = 8;
	} else if (end - 2 > start && S.startsWith("検索", end - 2)) button = 2;
	else if (end - 6 > start && isSearchWord(end - 6)) button = 6;
	return button >= 0 && isSpace(S.charCodeAt(end - button - 1));
}
/**
* 行全体が「検索語 空白 検索ボタン」の行。
* 行頭ごとに行を 1 文字ずつ読むと全文を 2 回読むことになるので、行末の形を先に見て成立し得ない行を落とす。
*/
function search(i) {
	const start = i + newLine(i);
	if (!lineBegin(start)) return -1;
	if (!endsWithSearchButton(start, lineEndFrom(start))) return -1;
	let p = start;
	let button = -1;
	while (p < L && newLine(p) === 0) {
		if (isSpace(S.charCodeAt(p))) {
			button = searchButton(p + 1);
			if (button >= 0 && lineEnd(p + 1 + button)) break;
			button = -1;
		}
		p++;
	}
	if (p === start || button < 0) return -1;
	const end = p + 1 + button;
	const query = S.slice(start, p);
	out = SEARCH(query, S.slice(start, end));
	return end + newLine(end);
}
function run(input, limit, read) {
	quoteRecords = null;
	setInput(input, null);
	depth = 0;
	nestLimit = limit;
	linkLabel = false;
	try {
		const acc = new Acc();
		let i = 0;
		while (i < L) {
			const from = i;
			i = read(i);
			acc.push(from, i, out);
		}
		return acc.done();
	} finally {
		quoteRecords = null;
		setInput("", null);
		out = "";
	}
}
function parseFull(input, limit) {
	return run(input, limit, full);
}
function parseSimple$1(input) {
	return run(input, Infinity, simple);
}
//#endregion
//#region src/internal/index.ts
function fullParser(input, opts) {
	return parseFull(input, opts.nestLimit != null ? opts.nestLimit : 20);
}
function simpleParser(input) {
	return parseSimple$1(input);
}
//#endregion
//#region src/internal/util.ts
function stringifyNode(node) {
	switch (node.type) {
		case "quote": return stringifyTree(node.children).split("\n").map((line) => `> ${line}`).join("\n");
		case "search": return node.props.content;
		case "blockCode": return `\`\`\`${node.props.lang ?? ""}\n${node.props.code}\n\`\`\``;
		case "mathBlock": return `\\[\n${node.props.formula}\n\\]`;
		case "center": return `<center>\n${stringifyTree(node.children)}\n</center>`;
		case "emojiCode": return `:${node.props.name}:`;
		case "unicodeEmoji": return node.props.emoji;
		case "bold": return `**${stringifyTree(node.children)}**`;
		case "small": return `<small>${stringifyTree(node.children)}</small>`;
		case "italic": return `<i>${stringifyTree(node.children)}</i>`;
		case "strike": return `~~${stringifyTree(node.children)}~~`;
		case "inlineCode": return `\`${node.props.code}\``;
		case "mathInline": return `\\(${node.props.formula}\\)`;
		case "mention": return node.props.acct;
		case "hashtag": return `#${node.props.hashtag}`;
		case "url":
			if (node.props.brackets) return `<${node.props.url}>`;
			return node.props.url;
		case "link": return `${node.props.silent ? "?" : ""}[${stringifyTree(node.children)}](${node.props.url})`;
		case "fn": {
			const argFields = Object.keys(node.props.args).map((key) => {
				const value = node.props.args[key];
				if (value === true) return key;
				return `${key}=${value}`;
			});
			const args = argFields.length > 0 ? "." + argFields.join(",") : "";
			return `$[${node.props.name}${args} ${stringifyTree(node.children)}]`;
		}
		case "plain": return `<plain>\n${stringifyTree(node.children)}\n</plain>`;
		case "text": return node.props.text;
	}
	throw new Error("unknown mfm node");
}
function stringifyTree(nodes) {
	const dest = [];
	let state = 0;
	for (const node of nodes) {
		let pushLf = true;
		if (isMfmBlock(node)) {
			if (state === 0) pushLf = false;
			state = 2;
		} else {
			if (state === 0 || state === 1) pushLf = false;
			state = 1;
		}
		if (pushLf) dest.push("\n");
		dest.push(stringifyNode(node));
	}
	return dest.join("");
}
function inspectOne(node, action) {
	action(node);
	if (node.children != null) for (const child of node.children) inspectOne(child, action);
}
//#endregion
//#region src/api.ts
function parse(input, opts = {}) {
	return fullParser(input, opts.nestLimit === void 0 ? {} : { nestLimit: opts.nestLimit });
}
function parseSimple(input) {
	return simpleParser(input);
}
function toString(node) {
	if (Array.isArray(node)) return stringifyTree(node);
	return stringifyNode(node);
}
function inspect(node, action) {
	if (Array.isArray(node)) for (const n of node) inspectOne(n, action);
	else inspectOne(node, action);
}
function extract(nodes, predicate) {
	const dest = [];
	inspect(nodes, (node) => {
		if (predicate(node)) dest.push(node);
	});
	return dest;
}
/** メンションを重複除去し、初出順で返す。ユーザー名とホスト名は大文字小文字を区別しない。 */
function extractMentions(nodes) {
	const mentions = [];
	const seen = /* @__PURE__ */ new Set();
	inspect(nodes, (node) => {
		if (node.type !== "mention") return;
		const key = `${node.props.username.toLowerCase()}@${node.props.host?.toLowerCase() ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		mentions.push(node.props);
	});
	return mentions;
}
//#endregion
export { BOLD, CENTER, CODE_BLOCK, EMOJI_CODE, FN, HASHTAG, INLINE_CODE, ITALIC, LINK, MATH_BLOCK, MATH_INLINE, MENTION, N_URL, PLAIN, QUOTE, SEARCH, SMALL, STRIKE, TEXT, UNI_EMOJI, extract, extractMentions, inspect, isMfmBlock, parse, parseSimple, toString };

//# sourceMappingURL=index.js.map