import { emojiRegex } from '@misskey-dev/emoji-data';

import * as M from '../node';

// MFM の文法を、入力の位置を受け取って読み終えた位置 (失敗なら -1) を返す関数で書く。
// 各関数は成功したとき、読んだ結果 (ノードか、text になる文字列) を out に置く。
// 構文の優先順位と各構文の成立条件は test/reference/parser.ts の parser combinator と同じで、
// test/differential.ts が両者の出力の一致を確かめる。

type Value = M.MfmNode | string;
type Args = M.MfmFn['props']['args'];

const EMOJI_RE = new RegExp(emojiRegex.source, 'y');

// 構文を始め得ない UTF-16 コード単位は表引きだけで text とする。先頭文字の根拠 (各構文の最初に消費する文字) は次のとおり。
// - 改行 (\r \n): quote / codeBlock / mathBlock / centerTag / search は改行 1 つを読み飛ばしてから始まる
// - < > * _ ` \ ~ $ @ # : ? [: 各構文の開始記号 (quote の > と search は行頭でのみ成立)
// - h: url (/https?:\/\//)
// - 絵文字: emojiRegex のソースに現れる全コード単位 (先頭に限らないので上位集合)
// - 行頭 (直前が改行か入力の先頭): search は任意の文字から始まるため、行頭では表を使わない
const EMOJI_UNITS = collectRegexCodeUnits(emojiRegex);
/** 1 なら emojiRegex が一致し得る文字。列挙できない構成の正規表現なら全ての文字で試す。 */
const EMOJI_UNIT = new Uint8Array(0x10000).fill(EMOJI_UNITS == null ? 1 : 0);
/** 1 ならどの構文も始まり得ない文字。絵文字を列挙できなければ表引きを使わない。 */
const PLAIN = new Uint8Array(0x10000).fill(EMOJI_UNITS == null ? 0 : 1);
if (EMOJI_UNITS != null) {
	for (const unit of EMOJI_UNITS) {
		EMOJI_UNIT[unit] = 1;
		PLAIN[unit] = 0;
	}
	for (const char of '\r\n<>*_`\\~$@#:?[h') {
		PLAIN[char.charCodeAt(0)] = 0;
	}
}

// 正規表現のソースに現れるコード単位を、文字クラスの範囲も展開して集める。列挙できない構成
// (. / \d 等の文字集合エスケープ / 否定クラス / i・u・v フラグ) があれば null を返す。
function collectRegexCodeUnits(pattern: RegExp): Set<number> | null {
	if (/[iuv]/.test(pattern.flags)) {
		return null;
	}
	const source = pattern.source;
	const units = new Set<number>();
	let inClass = false;
	let rangeFrom: number | null = null;
	let previous: number | null = null;
	const add = (unit: number) => {
		if (rangeFrom != null) {
			for (let u = rangeFrom; u <= unit; u++) {
				units.add(u);
			}
			rangeFrom = null;
		} else {
			units.add(unit);
		}
		previous = unit;
	};
	for (let i = 0; i < source.length; i++) {
		const char = source.charAt(i);
		if (char === '\\') {
			const next = source[i + 1];
			if (next === 'u') {
				add(Number.parseInt(source.slice(i + 2, i + 6), 16));
				i += 5;
				continue;
			}
			if (next == null || /[dDwWsSpPbBkcx0-9]/.test(next)) {
				return null;
			}
			add(next.charCodeAt(0));
			i++;
			continue;
		}
		if (inClass) {
			if (char === ']') {
				inClass = false;
				previous = null;
				continue;
			}
			if (char === '-' && previous != null && source[i + 1] !== ']') {
				rangeFrom = previous;
				continue;
			}
			add(char.charCodeAt(0));
			continue;
		}
		if (char === '[') {
			if (source[i + 1] === '^') {
				return null;
			}
			inClass = true;
			previous = null;
			continue;
		}
		if (char === '.') {
			return null;
		}
		add(char.charCodeAt(0));
	}
	return units;
}

// ---- 1 回の parse の間の状態 ----
// 引用の中身は別の文字列として読み直すので、S と L はその間だけ中身に替わる。
let S = '';
let L = 0;
let depth = 0;
let nestLimit = 20;
let linkLabel = false;
let out: Value = '';

/**
 * 入力の文字列ごとの記録。failures は本文ループの失敗位置 (scanFailed)、lf / cr / founds は先の位置の検索結果 (findFrom)。
 * 行末は行頭ごとに引くので、改行 2 つは Map を通さずに持つ。
 */
type InputRecords = {
	failures: Map<number, Set<number>> | null;
	lf: Found;
	cr: Found;
	founds: Map<string, Found> | null;
};
const newRecords = (): InputRecords => ({ failures: null, lf: { from: 0, at: -1 }, cr: { from: 0, at: -1 }, founds: null });
/**
 * 引用の中身の記録。同じ内容の引用は同じ記録を使う。文字列をキーに引くと、別に作られた同じ内容の文字列とは
 * 全文を比べることになるので、引くのは引用に入るときだけにし、それ以外は current を使う。
 */
let quoteRecords: Map<string, InputRecords> | null = null;
/** 今の S の記録。最上位の入力では、初めて使うときに作る。 */
let current: InputRecords | null = null;

function setInput(input: string, inputRecords: InputRecords | null): void {
	S = input;
	L = input.length;
	current = inputRecords;
}

function currentRecords(): InputRecords {
	current ??= newRecords();
	return current;
}

function recordsOfQuote(content: string): InputRecords {
	quoteRecords ??= new Map();
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
class Acc {
	nodes: M.MfmNode[] = [];
	private start = 0;
	private end = 0;
	private has = false;

	/** [from, to) を読んだ結果 value を積む。value が文字列なら S.slice(from, to) と同じ。 */
	push(from: number, to: number, value: Value): void {
		if (typeof value === 'string') {
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

	private flush(): void {
		if (this.has) {
			this.nodes.push(M.TEXT(S.slice(this.start, this.end)));
			this.has = false;
		}
	}

	/** S が積んだときと同じ文字列の間に呼ぶ。 */
	done(): M.MfmNode[] {
		this.flush();
		return this.nodes;
	}
}

// ---- 文字の判定 ----
const LF = 0x0a;
const CR = 0x0d;

/** i にある改行の長さ (\r\n は 2)。改行でなければ 0。 */
function newLine(i: number): number {
	if (i >= L) return 0;
	const c = S.charCodeAt(i);
	if (c === CR) return S.charCodeAt(i + 1) === LF ? 2 : 1;
	return c === LF ? 1 : 0;
}

function lineBegin(i: number): boolean {
	if (i === 0) return true;
	const c = S.charCodeAt(i - 1);
	return c === LF || c === CR;
}

function lineEnd(i: number): boolean {
	if (i === L) return true;
	const c = S.charCodeAt(i);
	return c === LF || c === CR;
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x3000 || c === 0x09;
const isAlnum = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** [a-z0-9_]、大文字小文字を区別しない */
const isNameChar = (c: number): boolean => isAlnum(c) || c === 0x5f;
/** [a-z0-9_.-]、大文字小文字を区別しない */
const isHostChar = (c: number): boolean => isAlnum(c) || c === 0x5f || c === 0x2e || c === 0x2d;
const isDotOrDash = (c: number): boolean => c === 0x2e || c === 0x2d;
/** 直前の 1 文字が英数字か。直前を見る構文は、英単語の途中では成立しない。 */
const prevAlnum = (i: number): boolean => i > 0 && isAlnum(S.charCodeAt(i - 1));

// ---- 本文ループの失敗位置の記録 ----
// 開き記号の後で本文を繰り返し読んでから閉じ記号を読む構文は、閉じの無い開き記号が 1 行に並ぶと、
// 開始位置ごとに本文を行末 (<center> や \[ では入力末尾) まで読み直して失敗し、長さの 2 乗の時間になる。
// 本文ループのある位置から先の結果は入力・位置・深さ・リンクラベル内かどうかだけで決まり、ループは後戻りしないので、
// 失敗した試行が通った位置を覚え、後の試行がそこへ来たら読まずに失敗とする。
// 成功した試行の位置は覚えない (外側はその終端より後から再開する)。
// 本文の件数が足りない失敗は、そこまでに読んだ件数で決まり位置だけでは決まらないので覚えない。
const SCAN_MATH_BLOCK = 0;
const SCAN_CENTER = 1;
const SCAN_PLAIN = 2;
const SCAN_MATH_INLINE = 3;
const SCAN_LINK = 4;
const SCAN_URL_ALT = 5;
const SCAN_KINDS = 6;

/** 今の深さとリンクラベル内外での、本文ループ kind の記録の番号。 */
function scanSlot(kind: number): number {
	return (depth * 2 + (linkLabel ? 1 : 0)) * SCAN_KINDS + kind;
}

/** 記録した失敗位置。たいていの入力は一度も失敗を記録しないので、記録するまで入れ物を作らず undefined を返す。 */
function scanFailed(slot: number): Set<number> | undefined {
	return currentRecords().failures?.get(slot);
}

function scanFailedForWrite(slot: number): Set<number> {
	const inputRecords = currentRecords();
	inputRecords.failures ??= new Map();
	let failed = inputRecords.failures.get(slot);
	if (failed == null) {
		failed = new Set();
		inputRecords.failures.set(slot, failed);
	}
	return failed;
}

/**
 * 1 文字ずつ読む本文ループ。start から stop(p) が真になる位置まで読み、1 文字以上あれば tail で閉じ記号を読む。
 * 成功したら閉じの後の位置を返す。本文の終わりは stop が真になった最初の位置。
 */
function scanChars(start: number, kind: number, stop: (p: number) => boolean, tail: (p: number) => number): number {
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
function markFailed(slot: number, from: number, to: number): number {
	const failed = scanFailedForWrite(slot);
	for (let p = from; p < to; p++) {
		failed.add(p);
	}
	return -1;
}

/** 試行が通った位置を失敗位置として覚え、-1 を返す。 */
function markVisitedFailed(slot: number, visited: readonly number[]): number {
	const failed = scanFailedForWrite(slot);
	for (const p of visited) {
		failed.add(p);
	}
	return -1;
}

// ---- 先の位置の検索 ----
// 行末や閉じ記号を問い合わせのたびに探すと、閉じの無い開き記号や行が並ぶ入力で、同じ範囲を何度も末尾まで読むことになる。
// 文字列ごと・探すものごとに「[from, at) には無く at にある (無ければ入力末尾)」を覚え、その範囲からの問い合わせに使い回す。
// 引用の中身は別の文字列で、同じ内容の引用は同じ記録を共有するので、問い合わせの位置は前後し得る。
type Found = { from: number; at: number };

/** q 以降で最初に key が現れる位置 (無ければ L)。find を渡すと、key は名前として使い find で探す。 */
function findFrom(key: string, q: number, find?: (q: number) => number): number {
	const inputRecords = currentRecords();
	inputRecords.founds ??= new Map();
	let found = inputRecords.founds.get(key);
	if (found == null) {
		found = { from: 0, at: -1 };
		inputRecords.founds.set(key, found);
	}
	return findWith(found, q, key, find);
}

/** found が q を含む範囲を覚えていればそれを、無ければ探して覚え直した位置を返す。find が無ければ needle を探す。 */
function findWith(found: Found, q: number, needle: string, find?: (q: number) => number): number {
	if (found.from <= q && q <= found.at) return found.at;
	let at: number;
	if (find != null) {
		at = find(q);
	} else {
		at = S.indexOf(needle, q);
		if (at < 0) at = L;
	}
	found.from = q;
	found.at = at;
	return at;
}

/** 入れ子の上限内なら inline を、超えたら 1 文字を読む。 */
function nestInline(p: number): number {
	depth++;
	let end: number;
	if (depth < nestLimit) {
		end = inline(p);
	} else {
		out = S.charAt(p);
		end = p + 1;
	}
	depth--;
	return end;
}

// ---- 構文の選択 ----
// 各位置では、その文字で始まり得る構文だけを優先順位の順に試し、全て失敗したら 1 文字の text にする。
// 普通の文字が続く間はまとめて 1 つの text にする (結合されるので出力は同じ)。途中で止めるのは、構文を始め得る文字と、
// 入れ子の外側のループが閉じ判定に使う文字の手前。閉じ判定の先頭文字は 改行・<・*・~・] で、] 以外は表で既に止まる。
// 外側の判定は各呼び出しの前にだけ走るため、呼び出し位置の 1 文字目が ] でも、その先の ] で止まれば判定を飛ばさない。
const CLOSE_BRACKET = 0x5d;

function plainRun(i: number): number {
	let end = i + 1;
	while (end < L) {
		const c = S.charCodeAt(end);
		if (PLAIN[c] !== 1 || c === CLOSE_BRACKET) break;
		end++;
	}
	out = S.slice(i, end);
	return end;
}

function full(i: number): number {
	const c = S.charCodeAt(i);
	const atLineBegin = lineBegin(i);
	if (!atLineBegin && PLAIN[c] === 1) return plainRun(i);
	const isNewLine = c === LF || c === CR;
	let end: number;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if ((isNewLine || c === 0x3c) && (end = centerTag(i)) >= 0) return end;
	if ((end = inlineMarks(i, c)) >= 0) return end;
	if ((isNewLine || c === 0x60) && (end = codeBlock(i)) >= 0) return end;
	if (c === 0x60 && (end = inlineCode(i)) >= 0) return end;
	if ((isNewLine || c === 0x3e) && (end = quote(i)) >= 0) return end;
	if ((isNewLine || c === 0x5c) && (end = mathBlock(i)) >= 0) return end;
	if (c === 0x5c && (end = mathInline(i)) >= 0) return end;
	if ((end = inlineTail(i, c)) >= 0) return end;
	if ((isNewLine || atLineBegin) && (end = search(i)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}

function inline(i: number): number {
	const c = S.charCodeAt(i);
	if (!lineBegin(i) && PLAIN[c] === 1) return plainRun(i);
	let end: number;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if ((end = inlineMarks(i, c)) >= 0) return end;
	if (c === 0x60 && (end = inlineCode(i)) >= 0) return end;
	if (c === 0x5c && (end = mathInline(i)) >= 0) return end;
	if ((end = inlineTail(i, c)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}

function simple(i: number): number {
	const c = S.charCodeAt(i);
	if (!lineBegin(i) && PLAIN[c] === 1) return plainRun(i);
	let end: number;
	if (EMOJI_UNIT[c] === 1 && (end = unicodeEmoji(i)) >= 0) return end;
	if (c === 0x3a && (end = emojiCode(i)) >= 0) return end;
	if (c === 0x3c && (end = plainTag(i)) >= 0) return end;
	out = S.charAt(i);
	return i + 1;
}

/** smallTag, plainTag, boldTag, italicTag, strikeTag, urlAlt, big, boldAsta, italicAsta, boldUnder, italicUnder の順 */
function inlineMarks(i: number, c: number): number {
	let end: number;
	switch (c) {
		case 0x3c: // <
			if ((end = wrap(i, '<small>', '</small>', M.SMALL)) >= 0) return end;
			if ((end = plainTag(i)) >= 0) return end;
			if ((end = wrap(i, '<b>', '</b>', M.BOLD)) >= 0) return end;
			if ((end = wrap(i, '<i>', '</i>', M.ITALIC)) >= 0) return end;
			if ((end = wrap(i, '<s>', '</s>', M.STRIKE)) >= 0) return end;
			return urlAlt(i);
		case 0x2a: // *
			if ((end = wrap(i, '***', '***', tada)) >= 0) return end;
			if ((end = wrap(i, '**', '**', M.BOLD)) >= 0) return end;
			return italicMark(i, 0x2a);
		case 0x5f: // _
			if ((end = boldUnder(i)) >= 0) return end;
			return italicMark(i, 0x5f);
	}
	return -1;
}

/** strikeWave, fn, mention, hashtag, emojiCode, link, url (先頭の文字がそれぞれ異なる) */
function inlineTail(i: number, c: number): number {
	switch (c) {
		case 0x7e: // ~
			return wrap(i, '~~', '~~', M.STRIKE);
		case 0x24: // $
			return fn(i);
		case 0x40: // @
			return mention(i);
		case 0x23: // #
			return hashtag(i);
		case 0x3a: // :
			return emojiCode(i);
		case 0x3f: // ?
		case 0x5b: // [
			return link(i);
		case 0x68: // h
			return url(i);
	}
	return -1;
}

// ---- 開き記号と閉じ記号で囲むインライン ----
const tada = (children: M.MfmInline[]): M.MfmFn => M.FN('tada', {}, children);

/**
 * open の後、close の手前まで inline を 1 つ以上読み、close で閉じる。
 * open の直後が close なら open だけを、閉じられなければ読んだ範囲全体を text にする。~~ は改行の手前でも止まる。
 */
function wrap(i: number, open: string, close: string, node: (children: M.MfmInline[]) => M.MfmInline): number {
	if (!S.startsWith(open, i)) return -1;
	const stopAtNewLine = close === '~~';
	const bodyStart = i + open.length;
	const acc = new Acc();
	let p = bodyStart;
	// 入れ子の上限の手前では中身を 1 文字ずつ読むので、閉じ記号 (~~ は改行も) の手前まで一度に進める
	if (depth + 1 >= nestLimit && p < L) {
		let end = findFrom(close, p);
		if (stopAtNewLine) end = Math.min(end, lineEndFrom(p));
		if (end > p) {
			acc.push(p, end, '');
			p = end;
		}
	}
	while (p < L) {
		if (S.startsWith(close, p) || (stopAtNewLine && newLine(p) > 0)) break;
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
	out = node(acc.done() as M.MfmInline[]);
	return p + close.length;
}

/** 英数字と空白だけの本文を読む (__ と _ と * の強調)。 */
function alnumSpaceRun(p: number): number {
	while (p < L) {
		const c = S.charCodeAt(p);
		if (!isAlnum(c) && !isSpace(c)) break;
		p++;
	}
	return p;
}

function boldUnder(i: number): number {
	if (!S.startsWith('__', i)) return -1;
	const p = alnumSpaceRun(i + 2);
	if (p === i + 2 || !S.startsWith('__', p)) return -1;
	out = M.BOLD([M.TEXT(S.slice(i + 2, p))]);
	return p + 2;
}

function italicMark(i: number, mark: number): number {
	if (S.charCodeAt(i) !== mark) return -1;
	const p = alnumSpaceRun(i + 1);
	if (p === i + 1 || S.charCodeAt(p) !== mark || prevAlnum(i)) return -1;
	out = M.ITALIC([M.TEXT(S.slice(i + 1, p))]);
	return p + 1;
}

// ---- ブロック ----
function quote(i: number): number {
	let q = i;
	q += newLine(q);
	q += newLine(q);
	if (!lineBegin(q) || S.charCodeAt(q) !== 0x3e) return -1;
	const lines: string[] = [];
	let p = quoteLine(q, lines);
	while (p < L) {
		const n = newLine(p);
		if (n === 0 || S.charCodeAt(p + n) !== 0x3e) break;
		p = quoteLine(p + n, lines);
	}
	p += newLine(p);
	p += newLine(p);
	if (lines.length === 1 && lines[0] === '') return -1;
	// 中身は > を除いた行をつないだ別の文字列として、同じ深さ・上限で読み直す。上限を超えたら全て text
	const outer = S;
	const outerRecords = current;
	const content = lines.join('\n');
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
	} else {
		acc.push(0, L, S);
	}
	depth--;
	const children = acc.done();
	setInput(outer, outerRecords);
	out = M.QUOTE(children);
	return p;
}

/** > と続く空白 1 つの後、行末までを中身とする。 */
function quoteLine(p: number, lines: string[]): number {
	p++;
	if (p < L && isSpace(S.charCodeAt(p))) p++;
	const start = p;
	while (p < L && newLine(p) === 0) p++;
	lines.push(S.slice(start, p));
	return p;
}

/** 改行・```・行末の並び。コードブロックの本文はこの手前で終わる。 */
function codeBlockCloseAt(p: number): boolean {
	const n = newLine(p);
	return n > 0 && S.startsWith('```', p + n) && lineEnd(p + n + 3);
}

function codeBlockCloseFrom(q: number): number {
	let p = q;
	while (p < L && !codeBlockCloseAt(p)) p++;
	return p;
}

function codeBlock(i: number): number {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith('```', q)) return -1;
	q += 3;
	const langStart = q;
	while (q < L && newLine(q) === 0) q++;
	const lang = S.slice(langStart, q).trim();
	const n = newLine(q);
	if (n === 0) return -1;
	q += n;
	const codeStart = q;
	const p = findFrom('codeBlockClose', q, codeBlockCloseFrom);
	if (p === codeStart || p >= L) return -1;
	let end = p + newLine(p) + 3;
	end += newLine(end);
	out = M.CODE_BLOCK(S.slice(codeStart, p), lang.length > 0 ? lang : null);
	return end;
}

/** 改行 1 つを挟んでよい閉じ記号の後が行末なら、その後 (改行 1 つまで含む) の位置。 */
function blockClose(p: number, close: string): number {
	let q = p + newLine(p);
	if (!S.startsWith(close, q)) return -1;
	q += close.length;
	if (!lineEnd(q)) return -1;
	return q + newLine(q);
}

const stopMathBlock = (p: number): boolean => S.startsWith('\\]', p + newLine(p));
const closeMathBlock = (p: number): number => blockClose(p, '\\]');

function mathBlock(i: number): number {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith('\\[', q)) return -1;
	q += 2;
	q += newLine(q);
	const start = q;
	const end = scanChars(start, SCAN_MATH_BLOCK, stopMathBlock, closeMathBlock);
	if (end < 0) return -1;
	let p = start;
	while (!stopMathBlock(p)) p++;
	out = M.MATH_BLOCK(S.slice(start, p));
	return end;
}

function centerTag(i: number): number {
	let q = i + newLine(i);
	if (!lineBegin(q) || !S.startsWith('<center>', q)) return -1;
	q += 8;
	q += newLine(q);
	const slot = scanSlot(SCAN_CENTER);
	const failed = scanFailed(slot);
	const visited: number[] = [];
	const acc = new Acc();
	let p = q;
	let stopped = false;
	while (p < L) {
		if (failed?.has(p)) {
			stopped = true;
			break;
		}
		visited.push(p);
		if (S.startsWith('</center>', p + newLine(p))) break;
		const from = p;
		p = nestInline(p);
		acc.push(from, p, out);
	}
	if (!stopped && p >= L && failed?.has(p)) stopped = true;
	if (!stopped && p === q) return -1;
	let end = -1;
	if (!stopped) {
		visited.push(p);
		end = blockClose(p, '</center>');
	}
	if (end < 0) return markVisitedFailed(slot, visited);
	out = M.CENTER(acc.done() as M.MfmInline[]);
	return end;
}

const stopPlain = (p: number): boolean => S.startsWith('</plain>', p + newLine(p));
function closePlain(p: number): number {
	const q = p + newLine(p);
	return S.startsWith('</plain>', q) ? q + 8 : -1;
}

function plainTag(i: number): number {
	if (!S.startsWith('<plain>', i)) return -1;
	let q = i + 7;
	q += newLine(q);
	const start = q;
	const end = scanChars(start, SCAN_PLAIN, stopPlain, closePlain);
	if (end < 0) return -1;
	let p = start;
	while (!stopPlain(p)) p++;
	out = M.PLAIN(S.slice(start, p));
	return end;
}

// ---- インライン ----
function inlineCode(i: number): number {
	let p = i + 1;
	while (p < L) {
		const c = S.charCodeAt(p);
		// ` と ´ と改行の手前まで
		if (c === 0x60 || c === 0xb4 || c === LF || c === CR) break;
		p++;
	}
	if (p === i + 1 || S.charCodeAt(p) !== 0x60) return -1;
	out = M.INLINE_CODE(S.slice(i + 1, p));
	return p + 1;
}

const stopMathInline = (p: number): boolean => S.startsWith('\\)', p) || newLine(p) > 0;
const closeMathInline = (p: number): number => (S.startsWith('\\)', p) ? p + 2 : -1);

function mathInline(i: number): number {
	if (!S.startsWith('\\(', i)) return -1;
	const start = i + 2;
	const end = scanChars(start, SCAN_MATH_INLINE, stopMathInline, closeMathInline);
	if (end < 0) return -1;
	out = M.MATH_INLINE(S.slice(start, end - 2));
	return end;
}

function unicodeEmoji(i: number): number {
	EMOJI_RE.lastIndex = i;
	const match = EMOJI_RE.exec(S);
	if (match == null) return -1;
	const content = match[0];
	// 異体字セレクタ（U+FE0F）は絵文字ノードにせず文字として扱う。
	out = content === '️' ? content : M.UNI_EMOJI(content);
	return i + content.length;
}

function emojiCode(i: number): number {
	let p = i + 1;
	while (p < L) {
		const c = S.charCodeAt(p);
		// [a-z0-9_+-]
		if (!isNameChar(c) && c !== 0x2b && c !== 0x2d) break;
		p++;
	}
	if (p === i + 1 || S.charCodeAt(p) !== 0x3a) return -1;
	const end = p + 1;
	if (end < L && isAlnum(S.charCodeAt(end))) return -1;
	out = M.EMOJI_CODE(S.slice(i + 1, p));
	return end;
}

/** $[name.k=v,k2 本文]。名前・引数・空白・本文・] のどこかで失敗したら、そこまでを text にする。 */
function fn(i: number): number {
	if (!S.startsWith('$[', i)) return -1;
	let p = i + 2;
	const nameStart = p;
	while (p < L && isNameChar(S.charCodeAt(p))) p++;
	if (p === nameStart) {
		out = S.slice(i, p);
		return p;
	}
	const name = S.slice(nameStart, p);
	const args: Args = {};
	if (S.charCodeAt(p) === 0x2e) {
		const pairs: [string, string | true][] = [];
		let q = fnArg(p + 1, pairs);
		if (q >= 0) {
			while (q < L && S.charCodeAt(q) === 0x2c) {
				const next = fnArg(q + 1, pairs);
				if (next < 0) break;
				q = next;
			}
			for (const [key, value] of pairs) {
				args[key] = value;
			}
			p = q;
		}
	}
	if (S.charCodeAt(p) !== 0x20) {
		out = S.slice(i, p);
		return p;
	}
	p++;
	const bodyStart = p;
	const acc = new Acc();
	// 入れ子の上限の手前では中身を 1 文字ずつ読むので、] の手前まで一度に進める
	if (depth + 1 >= nestLimit && p < L) {
		const end = findFrom(']', p);
		if (end > p) {
			acc.push(p, end, '');
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
	out = M.FN(name, args, acc.done() as M.MfmInline[]);
	return p + 1;
}

/** 引数 1 つ (key か key=value) を読む。= の後に値が無ければ = を読まず key だけにする。 */
function fnArg(p: number, pairs: [string, string | true][]): number {
	const keyStart = p;
	while (p < L && isNameChar(S.charCodeAt(p))) p++;
	if (p === keyStart) return -1;
	const key = S.slice(keyStart, p);
	let value: string | true = true;
	if (S.charCodeAt(p) === 0x3d) {
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
function trailingDotsOrDashes(value: string): number {
	let n = value.length;
	while (n > 0 && isDotOrDash(value.charCodeAt(n - 1))) n--;
	return value.length - n;
}

function mention(i: number): number {
	if (linkLabel) return -1;
	let p = i + 1;
	while (p < L && isHostChar(S.charCodeAt(p))) p++;
	if (p === i + 1) return -1;
	const username = S.slice(i + 1, p);
	let hostname: string | null = null;
	if (S.charCodeAt(p) === 0x40) {
		let q = p + 1;
		while (q < L && isHostChar(S.charCodeAt(q))) q++;
		if (q > p + 1) {
			hostname = S.slice(p + 1, q);
			p = q;
		}
	}
	if (prevAlnum(i)) return -1;
	const resultIndex = p;
	// 末尾の . と - は名前に含めない。ホストがあるのにユーザー名の末尾が . か -、
	// ホストが . と - だけ、名前かホストが . か - で始まるものはメンションにせず、読んだ範囲を text にする。
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
		if (host == null) {
			name = username.slice(0, -trailing);
		} else {
			invalid = true;
		}
	}
	if (name.length === 0 || isDotOrDash(name.charCodeAt(0))) invalid = true;
	if (host != null && isDotOrDash(host.charCodeAt(0))) invalid = true;
	if (invalid) {
		out = S.slice(i, resultIndex);
		return resultIndex;
	}
	const acct = host != null ? `@${name}@${host}` : `@${name}`;
	out = M.MENTION(name, host, acct);
	return i + acct.length;
}

/** ハッシュタグに使えない文字: 空白・改行・句読点・引用符・括弧類 */
function isHashtagChar(c: number): boolean {
	switch (c) {
		case 0x20:
		case 0x3000:
		case 0x09:
		case LF:
		case CR:
		case 0x2e: // .
		case 0x2c: // ,
		case 0x21: // !
		case 0x3f: // ?
		case 0x27: // '
		case 0x22: // "
		case 0x23: // #
		case 0x3a: // :
		case 0x2f: // /
		case 0x5b: // [
		case 0x5d: // ]
		case 0x3010: // 【
		case 0x3011: // 】
		case 0x28: // (
		case 0x29: // )
		case 0x300c: // 「
		case 0x300d: // 」
		case 0xff08: // （
		case 0xff09: // ）
		case 0x3c: // <
		case 0x3e: // >
			return false;
	}
	return true;
}

/** [.,a-z0-9_/:%#@$&?!~=+-]、大文字小文字を区別しない */
const URL_CHAR = new Uint8Array(0x80);
for (const char of '.,_/:%#@$&?!~=+-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
	URL_CHAR[char.charCodeAt(0)] = 1;
}
const isUrlChar = (c: number): boolean => URL_CHAR[c] === 1;

/** ハッシュタグか URL の本文の 1 要素。括弧は対応する閉じ括弧があるときだけ中身ごと読み、入れ子の上限を超えたら文字だけを読む。 */
function bracketedItem(p: number, isUrl: boolean): number {
	const c = S.charCodeAt(p);
	let closer = -1;
	if (c === 0x28) closer = 0x29;
	else if (c === 0x5b) closer = 0x5d;
	else if (!isUrl && c === 0x300c) closer = 0x300d;
	else if (!isUrl && c === 0xff08) closer = 0xff09;
	if (closer < 0) {
		return (isUrl ? isUrlChar(c) : isHashtagChar(c)) ? p + 1 : -1;
	}
	let q = p + 1;
	while (q < L) {
		depth++;
		let next: number;
		if (depth < nestLimit) {
			next = bracketedItem(q, isUrl);
		} else {
			const d = S.charCodeAt(q);
			next = (isUrl ? isUrlChar(d) : isHashtagChar(d)) ? q + 1 : -1;
		}
		depth--;
		if (next < 0) break;
		q = next;
	}
	return S.charCodeAt(q) === closer ? q + 1 : -1;
}

function hashtag(i: number): number {
	if (linkLabel) return -1;
	let p = i + 1;
	let next: number;
	while (p < L && (next = bracketedItem(p, false)) >= 0) p = next;
	if (p === i + 1 || prevAlnum(i)) return -1;
	const value = S.slice(i + 1, p);
	// 数字だけのものはハッシュタグにしない
	if (/^[0-9]+$/.test(value)) return -1;
	out = M.HASHTAG(value);
	return p;
}

/** http:// か https:// の長さ。どちらでもなければ 0。 */
function schemeLength(i: number): number {
	if (!S.startsWith('http', i)) return 0;
	let p = i + 4;
	if (S.charCodeAt(p) === 0x73) p++;
	return S.startsWith('://', p) ? p + 3 - i : 0;
}

function url(i: number): number {
	if (linkLabel) return -1;
	const scheme = schemeLength(i);
	if (scheme === 0) return -1;
	const start = i + scheme;
	let p = start;
	let next: number;
	while (p < L && (next = bracketedItem(p, true)) >= 0) p = next;
	if (p === start) return -1;
	// 末尾の . と , は URL に含めない。それで本文が空になるなら、読んだ範囲を text にする
	let end = p;
	while (end > start) {
		const c = S.charCodeAt(end - 1);
		if (c !== 0x2e && c !== 0x2c) break;
		end--;
	}
	if (end === start) {
		out = S.slice(i, p);
		return p;
	}
	out = M.N_URL(S.slice(i, end), false);
	return end;
}

const stopUrlAlt = (p: number): boolean => {
	const c = S.charCodeAt(p);
	return c === 0x3e || isSpace(c);
};
const closeUrlAlt = (p: number): number => (S.charCodeAt(p) === 0x3e ? p + 1 : -1);

function urlAlt(i: number): number {
	if (linkLabel) return -1;
	const scheme = schemeLength(i + 1);
	if (scheme === 0) return -1;
	const end = scanChars(i + 1 + scheme, SCAN_URL_ALT, stopUrlAlt, closeUrlAlt);
	if (end < 0) return -1;
	out = M.N_URL(S.slice(i + 1, end - 1), true);
	return end;
}

/** [ラベル](url) と ?[ラベル](url)。ラベルの中ではリンク・メンション・ハッシュタグ・URL を読まない。 */
function link(i: number): number {
	if (linkLabel) return -1;
	let silent: boolean;
	if (S.startsWith('?[', i)) silent = true;
	else if (S.charCodeAt(i) === 0x5b) silent = false;
	else return -1;
	const labelStart = i + (silent ? 2 : 1);
	const slot = scanSlot(SCAN_LINK);
	const failed = scanFailed(slot);
	const visited: number[] = [];
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
	let target: M.MfmUrl | null = null;
	if (!stopped) {
		visited.push(p);
		// ](<url>) か ](url)。url が text になる (末尾の . , を除くと空) ときはリンクにしない
		if (S.charCodeAt(p) === CLOSE_BRACKET && S.charCodeAt(p + 1) === 0x28) {
			let urlEnd = urlAlt(p + 2);
			if (urlEnd < 0) urlEnd = url(p + 2);
			if (urlEnd >= 0 && typeof out !== 'string' && S.charCodeAt(urlEnd) === 0x29) {
				target = out as M.MfmUrl;
				end = urlEnd + 1;
			}
		}
	}
	if (target == null) return markVisitedFailed(slot, visited);
	out = M.LINK(silent, target.props.url, acc.done() as M.MfmInline[]);
	return end;
}

/** 検索ボタン ([検索] / [search] / 検索 / search、search は大文字小文字を区別しない) の長さ。無ければ -1。 */
function searchButton(p: number): number {
	if (S.charCodeAt(p) === 0x5b) {
		if (S.startsWith('検索]', p + 1)) return 4;
		if (isSearchWord(p + 1) && S.charCodeAt(p + 7) === CLOSE_BRACKET) return 8;
		return -1;
	}
	if (S.startsWith('検索', p)) return 2;
	if (isSearchWord(p)) return 6;
	return -1;
}

/** search を ASCII の英字だけ大文字小文字を区別せずに比べる (正規表現の i フラグと同じ) */
function isSearchWord(p: number): boolean {
	if (p + 6 > L) return false;
	for (let k = 0; k < 6; k++) {
		const c = S.charCodeAt(p + k);
		if ((c >= 0x41 && c <= 0x5a ? c + 0x20 : c) !== 'search'.charCodeAt(k)) return false;
	}
	return true;
}

/** q 以降で最初の改行 (\r か \n) の位置。無ければ L。 */
function lineEndFrom(q: number): number {
	const inputRecords = currentRecords();
	return Math.min(findWith(inputRecords.lf, q, '\n'), findWith(inputRecords.cr, q, '\r'));
}

/** 行 [start, end) が「空白 検索ボタン」で終わるか。検索構文が成立する行の必要条件。 */
function endsWithSearchButton(start: number, end: number): boolean {
	let button = -1;
	if (S.charCodeAt(end - 1) === CLOSE_BRACKET) {
		if (end - 4 > start && searchButton(end - 4) === 4) button = 4;
		else if (end - 8 > start && searchButton(end - 8) === 8) button = 8;
	} else if (end - 2 > start && S.startsWith('検索', end - 2)) {
		button = 2;
	} else if (end - 6 > start && isSearchWord(end - 6)) {
		button = 6;
	}
	return button >= 0 && isSpace(S.charCodeAt(end - button - 1));
}

/**
 * 行全体が「検索語 空白 検索ボタン」の行。
 * 行頭ごとに行を 1 文字ずつ読むと全文を 2 回読むことになるので、行末の形を先に見て成立し得ない行を落とす。
 */
function search(i: number): number {
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
	out = M.SEARCH(query, S.slice(start, end));
	return end + newLine(end);
}

// ---- 公開 ----
function run(input: string, limit: number, read: (i: number) => number): M.MfmNode[] {
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
		// 入力と記録を次の parse まで持ち続けない
		quoteRecords = null;
		setInput('', null);
		out = '';
	}
}

export function parseFull(input: string, limit: number): M.MfmNode[] {
	return run(input, limit, full);
}

export function parseSimple(input: string): M.MfmSimpleNode[] {
	return run(input, Infinity, simple) as M.MfmSimpleNode[];
}
