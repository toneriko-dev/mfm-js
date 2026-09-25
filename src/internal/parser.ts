import { emojiRegex } from '@misskey-dev/emoji-data';

import * as M from '../node';
import * as P from './core';
import { mergeText } from './util';
import type { SeqParseResult } from './core';

type ArgPair = { k: string; v: string | true };
type Args = Record<string, string | true>;

const space = P.regexp(/[\u0020\u3000\t]/);
const alphaAndNum = P.regexp(/[a-z0-9]/i);
const newLine = P.alt([P.crlf, P.cr, P.lf]);

function seqOrText<Parsers extends P.Parser<unknown>[]>(
	...parsers: Parsers
): P.Parser<SeqParseResult<Parsers> | string> {
	return new P.Parser<SeqParseResult<Parsers> | string>((input, index, state) => {
		const accum: unknown[] = [];
		let latestIndex = index;
		for (const parser of parsers) {
			const result = parser.handler(input, latestIndex, state);
			if (!result.success) {
				if (latestIndex === index) {
					return P.failure();
				}
				return P.success(latestIndex, input.slice(index, latestIndex));
			}
			accum.push(result.value);
			latestIndex = result.index;
		}
		return P.success(latestIndex, accum as SeqParseResult<Parsers>);
	});
}

const notLinkLabel = new P.Parser((_input, index, state) => {
	return !state.linkLabel ? P.success(index, null) : P.failure();
});

const nestable = new P.Parser((_input, index, state) => {
	return state.depth < state.nestLimit ? P.success(index, null) : P.failure();
});

function nest<T>(parser: P.Parser<T>, fallback?: P.Parser<string>): P.Parser<T | string> {
	// 入れ子制限内では指定 parser を使い、超過時は fallback（未指定時は1文字）を使う。
	const inner = P.alt([P.seq(nestable, parser).select(1), fallback != null ? fallback : P.char]);
	return new P.Parser<T | string>((input, index, state) => {
		state.depth++;
		const result = inner.handler(input, index, state);
		state.depth--;
		return result;
	});
}

/*
 * full / inline / simple は位置ごとに最大 27 構文を順に試し、全て失敗したときだけ 1 文字の text になる。
 * 普通の文章では大半の文字がこの経路を通り、日本語 189 字で約 560µs かかっていた (表引きと検索構文の行末判定の後は約 21µs)。
 * 構文ごとに成立し得る先頭の UTF-16 コード単位は決まっているので、どの構文も始まり得ない文字は
 * 候補を試さずに text とする。判定は表引きだけで、出力は変えない。
 *
 * 先頭文字の根拠 (各構文の最初に消費する parser):
 * - 改行 (\r \n): newLine.option() から始まる quote / codeBlock / mathBlock / centerTag / search
 * - < > * _ ` \ ~ $ @ # : ? [: 各構文の開始記号 (quote の > と search は行頭でのみ成立)
 * - h: url (/https?:\/\//)
 * - 絵文字: emojiRegex のソースに現れる全コード単位 (先頭に限らないので上位集合)
 * - 行頭 (直前が改行か入力の先頭): search は任意の文字から始まるため、行頭では常に候補を試す
 */
const EMOJI_UNITS = collectRegexCodeUnits(emojiRegex);
const PLAIN_TEXT_TABLE = buildPlainTextTable(EMOJI_UNITS);

function buildPlainTextTable(emojiUnits: Set<number> | null): Uint8Array | null {
	if (emojiUnits == null) {
		return null;
	}
	const table = new Uint8Array(0x10000).fill(1);
	for (const unit of emojiUnits) {
		table[unit] = 0;
	}
	for (const char of '\r\n<>*_`\\~$@#:?[h') {
		table[char.charCodeAt(0)] = 0;
	}
	return table;
}

/**
 * 正規表現のソースに現れるコード単位を、文字クラスの範囲も展開して集める。
 * 列挙できない構成 (. / \d 等の文字集合エスケープ / 否定クラス / i・u・v フラグ) があれば null を返し、
 * 呼び出し側は表引きを使わない。
 */
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

/*
 * 普通の文字が続く間はまとめて 1 つの text にする。mergeText で隣接 text は結合されるので出力は同じ。
 * 途中で止めるのは、構文を始め得る文字と、入れ子の外側のループが閉じ判定に使う文字の手前。
 * 閉じ判定 (notMatch(close) の直後に inline / full を呼ぶ箇所) の先頭文字は 改行・<・*・~・] で、
 * ] 以外は構文の開始文字として表で既に止まる。外側の判定は各呼び出しの前にだけ走るため、
 * 呼び出し位置の 1 文字目が ] でも、その先の ] で止まれば判定を飛ばさない。
 */
const CLOSE_BRACKET = 0x5d;

function withPlainTextFastPath<T>(parser: P.Parser<T | string>): P.Parser<T | string> {
	const table = PLAIN_TEXT_TABLE;
	if (table == null) {
		return parser;
	}
	return new P.Parser<T | string>((input, index, state) => {
		if (index > 0 && index < input.length) {
			const previous = input.charCodeAt(index - 1);
			if (previous !== 0x0a && previous !== 0x0d && table[input.charCodeAt(index)] === 1) {
				let end = index + 1;
				while (end < input.length) {
					const code = input.charCodeAt(end);
					if (table[code] !== 1 || code === CLOSE_BRACKET) {
						break;
					}
					end++;
				}
				return P.success(end, input.slice(index, end));
			}
		}
		return parser.handler(input, index, state);
	});
}

/** 構文が最初に消費し得る文字。emoji は emojiRegex に現れる全コード単位、lineBegin は行頭なら任意の文字。 */
type StartSet = { chars?: string; emoji?: true; lineBegin?: true; any?: true };

/*
 * 表で止まった位置 (構文を始め得る文字と行頭) では、全 27 構文を順に試していた。数字は絵文字の
 * キーキャップのため表で止まり、数字の多い文では 1 文字あたり約 1.6µs かかっていた。先頭の文字で成立し得ない
 * 構文を候補から外し、残りを元の順序のまま試す。P.alt は最初に成功した構文を採るので、外した構文が
 * その文字で必ず失敗する限り出力は変わらない。候補の組み合わせは数十通りなので、組み合わせごとに共有する。
 */
function dispatchAlt<T>(entries: readonly (readonly [P.Parser<T>, StartSet])[]): P.Parser<T> {
	const all = P.alt(entries.map(([parser]) => parser));
	const emojiUnits = EMOJI_UNITS;
	if (emojiUnits == null) {
		return all;
	}
	let anyMask = 0;
	let lineBeginMask = 0;
	let emojiMask = 0;
	const charMasks = new Map<number, number>();
	entries.forEach(([, start], bit) => {
		const flag = 1 << bit;
		if (start.any) anyMask |= flag;
		if (start.lineBegin) lineBeginMask |= flag;
		if (start.emoji) emojiMask |= flag;
		for (const char of start.chars ?? '') {
			const code = char.charCodeAt(0);
			charMasks.set(code, (charMasks.get(code) ?? 0) | flag);
		}
	});
	const byMask = new Map<number, P.Parser<T>>();
	return new P.Parser<T>((input, index, state) => {
		if (index >= input.length) {
			return all.handler(input, index, state);
		}
		const code = input.charCodeAt(index);
		const previous = index === 0 ? 0x0a : input.charCodeAt(index - 1);
		let mask = anyMask | (charMasks.get(code) ?? 0);
		if (previous === 0x0a || previous === 0x0d) mask |= lineBeginMask;
		if (emojiUnits.has(code)) mask |= emojiMask;
		let parser = byMask.get(mask);
		if (parser == null) {
			parser = P.alt(entries.filter((_, bit) => (mask & (1 << bit)) !== 0).map(([candidate]) => candidate));
			byMask.set(mask, parser);
		}
		return parser.handler(input, index, state);
	});
}

// 先頭文字の根拠は各構文の最初に消費する parser。改行で始まり得るのは newLine.option() を先頭に持つ構文。
const RULE_STARTS = {
	unicodeEmoji: { emoji: true },
	centerTag: { chars: '\r\n<' },
	smallTag: { chars: '<' },
	plainTag: { chars: '<' },
	boldTag: { chars: '<' },
	italicTag: { chars: '<' },
	strikeTag: { chars: '<' },
	urlAlt: { chars: '<' },
	big: { chars: '*' },
	boldAsta: { chars: '*' },
	italicAsta: { chars: '*' },
	boldUnder: { chars: '_' },
	italicUnder: { chars: '_' },
	codeBlock: { chars: '\r\n`' },
	inlineCode: { chars: '`' },
	quote: { chars: '\r\n>' },
	mathBlock: { chars: '\r\n\\' },
	mathInline: { chars: '\\' },
	strikeWave: { chars: '~' },
	fn: { chars: '$' },
	mention: { chars: '@' },
	hashtag: { chars: '#' },
	emojiCode: { chars: ':' },
	link: { chars: '?[' },
	url: { chars: 'h' },
	search: { chars: '\r\n', lineBegin: true },
	text: { any: true },
} as const satisfies Record<string, StartSet>;

interface TypeTable {
	fullParser: (M.MfmNode | string)[];
	simpleParser: (M.MfmSimpleNode | string)[];
	full: M.MfmNode | string;
	simple: M.MfmSimpleNode | string;
	inline: M.MfmInline | string;
	quote: M.NodeType<'quote'>;
	codeBlock: M.NodeType<'blockCode'>;
	mathBlock: M.NodeType<'mathBlock'>;
	centerTag: M.NodeType<'center'>;
	big: M.NodeType<'fn'> | string;
	boldAsta: M.NodeType<'bold'> | string;
	boldTag: M.NodeType<'bold'> | string;
	boldUnder: M.NodeType<'bold'>;
	smallTag: M.NodeType<'small'> | string;
	italicTag: M.NodeType<'italic'> | string;
	italicAsta: M.NodeType<'italic'>;
	italicUnder: M.NodeType<'italic'>;
	strikeTag: M.NodeType<'strike'> | string;
	strikeWave: M.NodeType<'strike'> | string;
	unicodeEmoji: M.NodeType<'unicodeEmoji'> | string;
	plainTag: M.NodeType<'plain'>;
	fn: M.NodeType<'fn'> | string;
	inlineCode: M.NodeType<'inlineCode'>;
	mathInline: M.NodeType<'mathInline'>;
	mention: M.NodeType<'mention'> | string;
	hashtag: M.NodeType<'hashtag'>;
	emojiCode: M.NodeType<'emojiCode'>;
	link: M.NodeType<'link'>;
	url: M.NodeType<'url'> | string;
	urlAlt: M.NodeType<'url'>;
	search: M.NodeType<'search'>;
	text: string;
}

/**
 * optimizations: false は表引きと検索構文の行末判定を使わない元の文法。差分テストの基準にだけ使う。
 */
export function createMfmLanguage(opts: { optimizations: boolean }) {
	type RuleName = keyof typeof RULE_STARTS;
	// 元の文法は構文を順に試す P.alt。最適化時は先頭文字で候補を絞り、普通の文字の連続は表引きでまとめる。
	const choose = <T>(r: P.ParserTable<TypeTable>, names: readonly RuleName[]): P.Parser<T | string> => {
		const entries = names.map((name) => [r[name] as P.Parser<T | string>, RULE_STARTS[name]] as const);
		return opts.optimizations ? withPlainTextFastPath(dispatchAlt(entries)) : P.alt(entries.map(([parser]) => parser));
	};

	// P.altは最初にmatchしたparserを採用するため、各配列の順序は構文の優先順位を表す。
	return P.createLanguage<TypeTable>({
		fullParser: (r) => {
			return r.full.many(0);
		},

		simpleParser: (r) => {
			return r.simple.many(0);
		},

		full: (r) => {
			return choose(r, [
				'unicodeEmoji',
				'centerTag',
				'smallTag',
				'plainTag',
				'boldTag',
				'italicTag',
				'strikeTag',
				'urlAlt',
				'big',
				'boldAsta',
				'italicAsta',
				'boldUnder',
				'italicUnder',
				'codeBlock',
				'inlineCode',
				'quote',
				'mathBlock',
				'mathInline',
				'strikeWave',
				'fn',
				'mention',
				'hashtag',
				'emojiCode',
				'link',
				'url',
				'search',
				'text',
			]);
		},

		simple: (r) => {
			return choose(r, ['unicodeEmoji', 'emojiCode', 'plainTag', 'text']);
		},

		inline: (r) => {
			return choose(r, [
				'unicodeEmoji',
				'smallTag',
				'plainTag',
				'boldTag',
				'italicTag',
				'strikeTag',
				'urlAlt',
				'big',
				'boldAsta',
				'italicAsta',
				'boldUnder',
				'italicUnder',
				'inlineCode',
				'mathInline',
				'strikeWave',
				'fn',
				'mention',
				'hashtag',
				'emojiCode',
				'link',
				'url',
				'text',
			]);
		},

		quote: (r) => {
			const lines: P.Parser<string[]> = P.seq(
				P.str('>'),
				space.option(),
				P.seq(P.notMatch(newLine), P.char).select(1).many(0).text(),
			)
				.select(2)
				.sep(newLine, 1);
			const parser = P.seq(
				newLine.option(),
				newLine.option(),
				P.lineBegin,
				lines,
				newLine.option(),
				newLine.option(),
			).select(3);
			return new P.Parser((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) {
					return result;
				}
				const contents = result.value;
				const quoteIndex = result.index;
				if (contents.length === 1 && contents[0] === '') {
					return P.failure();
				}
				const contentParser = nest(r.fullParser).many(0);
				result = contentParser.handler(contents.join('\n'), 0, state);
				if (!result.success) {
					return result;
				}
				return P.success(quoteIndex, M.QUOTE(mergeText(result.value)));
			});
		},

		codeBlock: () => {
			const mark = P.str('```');
			return P.seq(
				newLine.option(),
				P.lineBegin,
				mark,
				P.seq(P.notMatch(newLine), P.char).select(1).many(0),
				newLine,
				P.seq(P.notMatch(P.seq(newLine, mark, P.lineEnd)), P.char)
					.select(1)
					.many(1),
				newLine,
				mark,
				P.lineEnd,
				newLine.option(),
			).map((result) => {
				const lang = result[3].join('').trim();
				const code = result[5].join('');
				return M.CODE_BLOCK(code, lang.length > 0 ? lang : null);
			});
		},

		mathBlock: () => {
			const open = P.str('\\[');
			const close = P.str('\\]');
			return P.seq(
				newLine.option(),
				P.lineBegin,
				open,
				newLine.option(),
				P.seq(P.notMatch(P.seq(newLine.option(), close)), P.char)
					.select(1)
					.many(1),
				newLine.option(),
				close,
				P.lineEnd,
				newLine.option(),
			).map((result) => {
				const formula = result[4].join('');
				return M.MATH_BLOCK(formula);
			});
		},

		centerTag: (r) => {
			const open = P.str('<center>');
			const close = P.str('</center>');
			return P.seq(
				newLine.option(),
				P.lineBegin,
				open,
				newLine.option(),
				P.seq(P.notMatch(P.seq(newLine.option(), close)), nest(r.inline))
					.select(1)
					.many(1),
				newLine.option(),
				close,
				P.lineEnd,
				newLine.option(),
			).map((result) => {
				return M.CENTER(mergeText(result[4]));
			});
		},

		big: (r) => {
			const mark = P.str('***');
			return seqOrText(mark, P.seq(P.notMatch(mark), nest(r.inline)).select(1).many(1), mark).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.FN('tada', {}, mergeText(result[1]));
			});
		},

		boldAsta: (r) => {
			const mark = P.str('**');
			return seqOrText(mark, P.seq(P.notMatch(mark), nest(r.inline)).select(1).many(1), mark).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.BOLD(mergeText(result[1]));
			});
		},

		boldTag: (r) => {
			const open = P.str('<b>');
			const close = P.str('</b>');
			return seqOrText(open, P.seq(P.notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.BOLD(mergeText(result[1]));
			});
		},

		boldUnder: () => {
			const mark = P.str('__');
			return P.seq(mark, P.alt([alphaAndNum, space]).many(1), mark).map((result) => M.BOLD(mergeText(result[1])));
		},

		smallTag: (r) => {
			const open = P.str('<small>');
			const close = P.str('</small>');
			return seqOrText(open, P.seq(P.notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.SMALL(mergeText(result[1]));
			});
		},

		italicTag: (r) => {
			const open = P.str('<i>');
			const close = P.str('</i>');
			return seqOrText(open, P.seq(P.notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.ITALIC(mergeText(result[1]));
			});
		},

		italicAsta: () => {
			const mark = P.str('*');
			const parser = P.seq(mark, P.alt([alphaAndNum, space]).many(1), mark);
			return new P.Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				// 直前の 1 文字だけを見る。先頭からの切り出しは一致のたびに入力長に比例していた。
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) {
					return P.failure();
				}
				return P.success(result.index, M.ITALIC(mergeText(result.value[1])));
			});
		},

		italicUnder: () => {
			const mark = P.str('_');
			const parser = P.seq(mark, P.alt([alphaAndNum, space]).many(1), mark);
			return new P.Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				// 直前の 1 文字だけを見る。先頭からの切り出しは一致のたびに入力長に比例していた。
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) {
					return P.failure();
				}
				return P.success(result.index, M.ITALIC(mergeText(result.value[1])));
			});
		},

		strikeTag: (r) => {
			const open = P.str('<s>');
			const close = P.str('</s>');
			return seqOrText(open, P.seq(P.notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.STRIKE(mergeText(result[1]));
			});
		},

		strikeWave: (r) => {
			const mark = P.str('~~');
			return seqOrText(
				mark,
				P.seq(P.notMatch(P.alt([mark, newLine])), nest(r.inline))
					.select(1)
					.many(1),
				mark,
			).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				return M.STRIKE(mergeText(result[1]));
			});
		},

		unicodeEmoji: () => {
			const emoji = RegExp(emojiRegex.source);
			return P.regexp(emoji).map((content) => {
				// 異体字セレクタ（U+FE0F）は絵文字ノードにせず文字として扱う。
				return content === '\uFE0F' ? content : M.UNI_EMOJI(content);
			});
		},

		plainTag: () => {
			const open = P.str('<plain>');
			const close = P.str('</plain>');
			return P.seq(
				open,
				newLine.option(),
				P.seq(P.notMatch(P.seq(newLine.option(), close)), P.char)
					.select(1)
					.many(1)
					.text(),
				newLine.option(),
				close,
			)
				.select(2)
				.map((result) => M.PLAIN(result));
		},

		fn: (r) => {
			const fnName = new P.Parser((input, index, state) => {
				const result = P.regexp(/[a-z0-9_]+/i).handler(input, index, state);
				if (!result.success) {
					return result;
				}
				return P.success(result.index, result.value);
			});
			const arg: P.Parser<ArgPair> = P.seq(
				P.regexp(/[a-z0-9_]+/i),
				P.seq(P.str('='), P.regexp(/[a-z0-9_.-]+/i))
					.select(1)
					.option(),
			).map((result) => {
				return {
					k: result[0],
					v: result[1] != null ? result[1] : true,
				};
			});
			const args = P.seq(P.str('.'), arg.sep(P.str(','), 1))
				.select(1)
				.map((pairs) => {
					const result: Args = {};
					for (const pair of pairs) {
						result[pair.k] = pair.v;
					}
					return result;
				});
			const fnClose = P.str(']');
			return seqOrText(
				P.str('$['),
				fnName,
				args.option(),
				P.str(' '),
				P.seq(P.notMatch(fnClose), nest(r.inline)).select(1).many(1),
				fnClose,
			).map((result) => {
				if (typeof result === 'string') {
					return result;
				}
				const name = result[1];
				const args: Args = result[2] || {};
				const content = result[4];
				return M.FN(name, args, mergeText(content));
			});
		},

		inlineCode: () => {
			const mark = P.str('`');
			return P.seq(
				mark,
				P.seq(P.notMatch(P.alt([mark, P.str('´'), newLine])), P.char)
					.select(1)
					.many(1),
				mark,
			).map((result) => M.INLINE_CODE(result[1].join('')));
		},

		mathInline: () => {
			const open = P.str('\\(');
			const close = P.str('\\)');
			return P.seq(
				open,
				P.seq(P.notMatch(P.alt([close, newLine])), P.char)
					.select(1)
					.many(1),
				close,
			).map((result) => M.MATH_INLINE(result[1].join('')));
		},

		mention: () => {
			const parser = P.seq(
				notLinkLabel,
				P.str('@'),
				P.regexp(/[a-z0-9_.-]+/i),
				P.seq(P.str('@'), P.regexp(/[a-z0-9_.-]+/i))
					.select(1)
					.option(),
			);
			return new P.Parser<M.MfmMention | string>((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				// 直前の 1 文字だけを見る。先頭からの切り出しは一致のたびに入力長に比例していた。
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) {
					return P.failure();
				}
				let invalidMention = false;
				const resultIndex = result.index;
				const username: string = result.value[2];
				const hostname: string | null = result.value[3];
				let modifiedHost = hostname;
				if (hostname != null) {
					result = /[.-]+$/.exec(hostname);
					if (result != null) {
						modifiedHost = hostname.slice(0, -1 * result[0].length);
						if (modifiedHost.length === 0) {
							invalidMention = true;
							modifiedHost = null;
						}
					}
				}
				let modifiedName = username;
				result = /[.-]+$/.exec(username);
				if (result != null) {
					if (modifiedHost == null) {
						modifiedName = username.slice(0, -1 * result[0].length);
					} else {
						invalidMention = true;
					}
				}
				if (modifiedName.length === 0 || /^[.-]/.test(modifiedName)) {
					invalidMention = true;
				}
				if (modifiedHost != null && /^[.-]/.test(modifiedHost)) {
					invalidMention = true;
				}
				if (invalidMention) {
					return P.success(resultIndex, input.slice(index, resultIndex));
				}
				const acct = modifiedHost != null ? `@${modifiedName}@${modifiedHost}` : `@${modifiedName}`;
				return P.success(index + acct.length, M.MENTION(modifiedName, modifiedHost, acct));
			});
		},

		hashtag: () => {
			const mark = P.str('#');
			const hashTagChar = P.seq(
				P.notMatch(P.alt([P.regexp(/[ \u3000\t.,!?'"#:/[\]【】()「」（）<>]/), space, newLine])),
				P.char,
			).select(1);
			const innerItem: P.Parser<unknown> = P.lazy(() =>
				P.alt([
					P.seq(P.str('('), nest(innerItem, hashTagChar).many(0), P.str(')')),
					P.seq(P.str('['), nest(innerItem, hashTagChar).many(0), P.str(']')),
					P.seq(P.str('「'), nest(innerItem, hashTagChar).many(0), P.str('」')),
					P.seq(P.str('（'), nest(innerItem, hashTagChar).many(0), P.str('）')),
					hashTagChar,
				]),
			);
			const parser = P.seq(notLinkLabel, mark, innerItem.many(1).text()).select(2);
			return new P.Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				// 直前の 1 文字だけを見る。先頭からの切り出しは一致のたびに入力長に比例していた。
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) {
					return P.failure();
				}
				const resultIndex = result.index;
				const resultValue = result.value;
				if (/^[0-9]+$/.test(resultValue)) {
					return P.failure();
				}
				return P.success(resultIndex, M.HASHTAG(resultValue));
			});
		},

		emojiCode: () => {
			const side = P.notMatch(P.regexp(/[a-z0-9]/i));
			const mark = P.str(':');
			return P.seq(P.alt([P.lineBegin, side]), mark, P.regexp(/[a-z0-9_+-]+/i), mark, P.alt([P.lineEnd, side]))
				.select(2)
				.map((name) => M.EMOJI_CODE(name));
		},

		link: (r) => {
			const labelInline = new P.Parser((input, index, state) => {
				state.linkLabel = true;
				const result = r.inline.handler(input, index, state);
				state.linkLabel = false;
				return result;
			});
			const closeLabel = P.str(']');
			const parser = P.seq(
				notLinkLabel,
				P.alt([P.str('?['), P.str('[')]),
				P.seq(P.notMatch(P.alt([closeLabel, newLine])), nest(labelInline))
					.select(1)
					.many(1),
				closeLabel,
				P.str('('),
				P.alt([r.urlAlt, r.url]),
				P.str(')'),
			);
			return new P.Parser<M.MfmLink>((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}

				const [, prefix, label, , , url] = result.value;

				const silent = prefix === '?[';
				if (typeof url === 'string') {
					return P.failure();
				}

				return P.success(result.index, M.LINK(silent, url.props.url, mergeText(label)));
			});
		},

		url: () => {
			const urlChar = P.regexp(/[.,a-z0-9_/:%#@$&?!~=+-]/i);
			const innerItem: P.Parser<unknown> = P.lazy(() =>
				P.alt([
					P.seq(P.str('('), nest(innerItem, urlChar).many(0), P.str(')')),
					P.seq(P.str('['), nest(innerItem, urlChar).many(0), P.str(']')),
					urlChar,
				]),
			);
			const parser = P.seq(notLinkLabel, P.regexp(/https?:\/\//), innerItem.many(1).text());
			return new P.Parser<M.MfmUrl | string>((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				const resultIndex = result.index;
				let modifiedIndex = resultIndex;
				const schema: string = result.value[1];
				let content: string = result.value[2];
				result = /[.,]+$/.exec(content);
				if (result != null) {
					modifiedIndex -= result[0].length;
					content = content.slice(0, -1 * result[0].length);
					if (content.length === 0) {
						return P.success(resultIndex, input.slice(index, resultIndex));
					}
				}
				return P.success(modifiedIndex, M.N_URL(schema + content, false));
			});
		},

		urlAlt: () => {
			const open = P.str('<');
			const close = P.str('>');
			const parser = P.seq(
				notLinkLabel,
				open,
				P.regexp(/https?:\/\//),
				P.seq(P.notMatch(P.alt([close, space])), P.char)
					.select(1)
					.many(1),
				close,
			).text();
			return new P.Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) {
					return P.failure();
				}
				const text = result.value.slice(1, -1);
				return P.success(result.index, M.N_URL(text, true));
			});
		},

		search: () => {
			const button = P.alt([P.regexp(/\[(検索|search)\]/i), P.regexp(/(検索|search)/i)]);
			// 検索構文は space + button の直後が lineEnd なので、行末がその形の行でしか成立しない。
			// 本体は行頭ごとに行全体を 1 文字ずつ notMatch で走査するため、行末を先に見て成立し得ない行を落とす。
			const lineTail = /[\u0020\u3000\t](?:\[(?:検索|search)\]|検索|search)$/i;
			const parser = P.seq(
				newLine.option(),
				P.lineBegin,
				P.seq(P.notMatch(P.alt([newLine, P.seq(space, button, P.lineEnd)])), P.char)
					.select(1)
					.many(1),
				space,
				button,
				P.lineEnd,
				newLine.option(),
			).map((result) => {
				const query = result[2].join('');
				return M.SEARCH(query, `${query}${result[3]}${result[4]}`);
			});
			if (!opts.optimizations) {
				return parser;
			}
			return new P.Parser<M.MfmSearch>((input, index, state) => {
				let lineStart = index;
				if (input.startsWith('\r\n', lineStart)) {
					lineStart += 2;
				} else if (input[lineStart] === '\r' || input[lineStart] === '\n') {
					lineStart += 1;
				}
				// 行頭でなければ本体の lineBegin で必ず失敗する。行末の判定より先に落とさないと、構文を
				// 始め得る文字のたびに行の残りを読み直し、長い行で文字数の 2 乗の時間になる (1,088 字で 7.3µs/字)。
				if (lineStart > 0 && input[lineStart - 1] !== '\n' && input[lineStart - 1] !== '\r') {
					return P.failure();
				}
				let lineEnd = lineStart;
				while (lineEnd < input.length && input[lineEnd] !== '\r' && input[lineEnd] !== '\n') {
					lineEnd++;
				}
				if (!lineTail.test(input.slice(lineStart, lineEnd))) {
					return P.failure();
				}
				return parser.handler(input, index, state);
			});
		},

		text: () => P.char,
	});
}

export const language = createMfmLanguage({ optimizations: true });
