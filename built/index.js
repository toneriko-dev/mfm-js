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
//#region src/internal/core/index.ts
const failed = { success: false };
function success(index, value) {
	return {
		success: true,
		value,
		index
	};
}
function failure() {
	return failed;
}
var Parser = class Parser {
	name;
	handler;
	constructor(handler, name) {
		this.handler = (input, index, state) => {
			if (state.trace && this.name != null) {
				const pos = `${index}`;
				console.log(`${pos.padEnd(6, " ")}enter ${this.name}`);
				const result = handler(input, index, state);
				if (result.success) {
					const pos = `${index}:${result.index}`;
					console.log(`${pos.padEnd(6, " ")}match ${this.name}`);
				} else {
					const pos = `${index}`;
					console.log(`${pos.padEnd(6, " ")}fail ${this.name}`);
				}
				return result;
			}
			return handler(input, index, state);
		};
		if (name !== void 0) this.name = name;
	}
	map(fn) {
		return new Parser((input, index, state) => {
			const result = this.handler(input, index, state);
			if (!result.success) return result;
			return success(result.index, fn(result.value));
		});
	}
	text() {
		return new Parser((input, index, state) => {
			const result = this.handler(input, index, state);
			if (!result.success) return result;
			const text = input.slice(index, result.index);
			return success(result.index, text);
		});
	}
	many(min) {
		return new Parser((input, index, state) => {
			let result;
			let latestIndex = index;
			const accum = [];
			while (latestIndex < input.length) {
				result = this.handler(input, latestIndex, state);
				if (!result.success) break;
				if (result.index <= latestIndex) throw new Error("A parser passed to many() must consume at least one character on success.");
				latestIndex = result.index;
				accum.push(result.value);
			}
			if (accum.length < min) return failure();
			return success(latestIndex, accum);
		});
	}
	sep(separator, min) {
		if (min < 1) throw new Error("\"min\" must be a value greater than or equal to 1.");
		return seq(this, seq(separator, this).select(1).many(min - 1)).map((result) => [result[0], ...result[1]]);
	}
	select(key) {
		return this.map((v) => v[key]);
	}
	option() {
		return alt([this, succeeded(null)]);
	}
};
function str(value) {
	return new Parser((input, index, _state) => {
		if (!input.startsWith(value, index)) return failure();
		return success(index + value.length, value);
	});
}
function regexp(pattern) {
	const flags = pattern.flags.replaceAll("g", "").replaceAll("y", "") + "y";
	const re = RegExp(pattern.source, flags);
	return new Parser((input, index, _state) => {
		re.lastIndex = index;
		const result = re.exec(input);
		if (result == null) return failure();
		return success(index + result[0].length, result[0]);
	});
}
function seq(...parsers) {
	return new Parser((input, index, state) => {
		let result;
		let latestIndex = index;
		const accum = [];
		for (const parser of parsers) {
			result = parser.handler(input, latestIndex, state);
			if (!result.success) return result;
			latestIndex = result.index;
			accum.push(result.value);
		}
		return success(latestIndex, accum);
	});
}
function alt(parsers) {
	return new Parser((input, index, state) => {
		for (const parser of parsers) {
			const result = parser.handler(input, index, state);
			if (result.success) return result;
		}
		return failure();
	});
}
function succeeded(value) {
	return new Parser((_input, index, _state) => {
		return success(index, value);
	});
}
function notMatch(parser) {
	return new Parser((input, index, state) => {
		return !parser.handler(input, index, state).success ? success(index, null) : failure();
	});
}
const cr = str("\r");
const lf = str("\n");
const crlf = str("\r\n");
const char = new Parser((input, index, _state) => {
	if (input.length - index < 1) return failure();
	const value = input.charAt(index);
	return success(index + 1, value);
});
const lineBegin = new Parser((input, index, _state) => {
	if (index === 0) return success(index, null);
	const previous = input.charCodeAt(index - 1);
	if (previous === 13 || previous === 10) return success(index, null);
	return failure();
});
const lineEnd = new Parser((input, index, _state) => {
	if (index === input.length) return success(index, null);
	const current = input.charCodeAt(index);
	if (current === 13 || current === 10) return success(index, null);
	return failure();
});
function lazy(fn) {
	const parser = new Parser((input, index, state) => {
		parser.handler = fn().handler;
		return parser.handler(input, index, state);
	});
	return parser;
}
function createLanguage(syntaxes) {
	const rules = {};
	for (const key of Object.keys(syntaxes)) rules[key] = lazy(() => {
		const parser = syntaxes[key](rules);
		if (parser == null) throw new Error("syntax must return a parser.");
		parser.name = key;
		return parser;
	});
	return rules;
}
//#endregion
//#region src/internal/util.ts
function mergeText(nodes) {
	const dest = [];
	const storedChars = [];
	function generateText() {
		if (storedChars.length > 0) {
			dest.push(TEXT(storedChars.join("")));
			storedChars.length = 0;
		}
	}
	const flatten = nodes.flat(1);
	for (const node of flatten) if (typeof node === "string") storedChars.push(node);
	else if (!Array.isArray(node) && node.type === "text") storedChars.push(node.props.text);
	else {
		generateText();
		dest.push(node);
	}
	generateText();
	return dest;
}
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
//#region src/internal/parser.ts
const space = regexp(/[\u0020\u3000\t]/);
const alphaAndNum = regexp(/[a-z0-9]/i);
const newLine = alt([
	crlf,
	cr,
	lf
]);
function seqOrText(...parsers) {
	return new Parser((input, index, state) => {
		const accum = [];
		let latestIndex = index;
		for (const parser of parsers) {
			const result = parser.handler(input, latestIndex, state);
			if (!result.success) {
				if (latestIndex === index) return failure();
				return success(latestIndex, input.slice(index, latestIndex));
			}
			accum.push(result.value);
			latestIndex = result.index;
		}
		return success(latestIndex, accum);
	});
}
const notLinkLabel = new Parser((_input, index, state) => {
	return !state.linkLabel ? success(index, null) : failure();
});
const nestable = new Parser((_input, index, state) => {
	return state.depth < state.nestLimit ? success(index, null) : failure();
});
function nest(parser, fallback) {
	const inner = alt([seq(nestable, parser).select(1), fallback != null ? fallback : char]);
	return new Parser((input, index, state) => {
		state.depth++;
		const result = inner.handler(input, index, state);
		state.depth--;
		return result;
	});
}
const EMOJI_UNITS = collectRegexCodeUnits(emojiRegex);
const PLAIN_TEXT_TABLE = buildPlainTextTable(EMOJI_UNITS);
function buildPlainTextTable(emojiUnits) {
	if (emojiUnits == null) return null;
	const table = (/* @__PURE__ */ new Uint8Array(65536)).fill(1);
	for (const unit of emojiUnits) table[unit] = 0;
	for (const char of "\r\n<>*_`\\~$@#:?[h") table[char.charCodeAt(0)] = 0;
	return table;
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
const CLOSE_BRACKET = 93;
function withPlainTextFastPath(parser) {
	const table = PLAIN_TEXT_TABLE;
	if (table == null) return parser;
	return new Parser((input, index, state) => {
		if (index > 0 && index < input.length) {
			const previous = input.charCodeAt(index - 1);
			if (previous !== 10 && previous !== 13 && table[input.charCodeAt(index)] === 1) {
				let end = index + 1;
				while (end < input.length) {
					const code = input.charCodeAt(end);
					if (table[code] !== 1 || code === CLOSE_BRACKET) break;
					end++;
				}
				return success(end, input.slice(index, end));
			}
		}
		return parser.handler(input, index, state);
	});
}
function dispatchAlt(entries) {
	const all = alt(entries.map(([parser]) => parser));
	const emojiUnits = EMOJI_UNITS;
	if (emojiUnits == null) return all;
	let anyMask = 0;
	let lineBeginMask = 0;
	let emojiMask = 0;
	const charMasks = /* @__PURE__ */ new Map();
	entries.forEach(([, start], bit) => {
		const flag = 1 << bit;
		if (start.any) anyMask |= flag;
		if (start.lineBegin) lineBeginMask |= flag;
		if (start.emoji) emojiMask |= flag;
		for (const char of start.chars ?? "") {
			const code = char.charCodeAt(0);
			charMasks.set(code, (charMasks.get(code) ?? 0) | flag);
		}
	});
	const byMask = /* @__PURE__ */ new Map();
	return new Parser((input, index, state) => {
		if (index >= input.length) return all.handler(input, index, state);
		const code = input.charCodeAt(index);
		const previous = index === 0 ? 10 : input.charCodeAt(index - 1);
		let mask = anyMask | (charMasks.get(code) ?? 0);
		if (previous === 10 || previous === 13) mask |= lineBeginMask;
		if (emojiUnits.has(code)) mask |= emojiMask;
		let parser = byMask.get(mask);
		if (parser == null) {
			parser = alt(entries.filter((_, bit) => (mask & 1 << bit) !== 0).map(([candidate]) => candidate));
			byMask.set(mask, parser);
		}
		return parser.handler(input, index, state);
	});
}
const RULE_STARTS = {
	unicodeEmoji: { emoji: true },
	centerTag: { chars: "\r\n<" },
	smallTag: { chars: "<" },
	plainTag: { chars: "<" },
	boldTag: { chars: "<" },
	italicTag: { chars: "<" },
	strikeTag: { chars: "<" },
	urlAlt: { chars: "<" },
	big: { chars: "*" },
	boldAsta: { chars: "*" },
	italicAsta: { chars: "*" },
	boldUnder: { chars: "_" },
	italicUnder: { chars: "_" },
	codeBlock: { chars: "\r\n`" },
	inlineCode: { chars: "`" },
	quote: { chars: "\r\n>" },
	mathBlock: { chars: "\r\n\\" },
	mathInline: { chars: "\\" },
	strikeWave: { chars: "~" },
	fn: { chars: "$" },
	mention: { chars: "@" },
	hashtag: { chars: "#" },
	emojiCode: { chars: ":" },
	link: { chars: "?[" },
	url: { chars: "h" },
	search: {
		chars: "\r\n",
		lineBegin: true
	},
	text: { any: true }
};
/** optimizations: false は表引き・候補の絞り込み・失敗位置の記録・検索構文の行末判定を使わない、差分テスト用の文法。 */
function createMfmLanguage(opts) {
	const choose = (r, names) => {
		const entries = names.map((name) => [r[name], RULE_STARTS[name]]);
		return opts.optimizations ? withPlainTextFastPath(dispatchAlt(entries)) : alt(entries.map(([parser]) => parser));
	};
	let scanKinds = 0;
	const scanThen = (item, min, tail) => {
		const plain = seq(item.many(min), tail);
		if (!opts.optimizations) return plain;
		const kind = scanKinds++;
		return new Parser((input, index, state) => {
			state.scanFailures ??= /* @__PURE__ */ new Map();
			let byKind = state.scanFailures.get(input);
			if (byKind == null) {
				byKind = /* @__PURE__ */ new Map();
				state.scanFailures.set(input, byKind);
			}
			const slot = (state.depth * 2 + (state.linkLabel ? 1 : 0)) * 64 + kind;
			let failed = byKind.get(slot);
			if (failed == null) {
				failed = /* @__PURE__ */ new Set();
				byKind.set(slot, failed);
			}
			const visited = [];
			const fail = () => {
				for (const position of visited) failed.add(position);
				return failure();
			};
			const items = [];
			let latestIndex = index;
			while (latestIndex < input.length) {
				if (failed.has(latestIndex)) return fail();
				visited.push(latestIndex);
				const result = item.handler(input, latestIndex, state);
				if (!result.success) break;
				latestIndex = result.index;
				items.push(result.value);
			}
			if (latestIndex >= input.length && failed.has(latestIndex)) return fail();
			if (items.length < min) return failure();
			visited.push(latestIndex);
			const result = tail.handler(input, latestIndex, state);
			if (!result.success) return fail();
			return success(result.index, [items, result.value]);
		});
	};
	return createLanguage({
		fullParser: (r) => {
			return r.full.many(0);
		},
		simpleParser: (r) => {
			return r.simple.many(0);
		},
		full: (r) => {
			return choose(r, [
				"unicodeEmoji",
				"centerTag",
				"smallTag",
				"plainTag",
				"boldTag",
				"italicTag",
				"strikeTag",
				"urlAlt",
				"big",
				"boldAsta",
				"italicAsta",
				"boldUnder",
				"italicUnder",
				"codeBlock",
				"inlineCode",
				"quote",
				"mathBlock",
				"mathInline",
				"strikeWave",
				"fn",
				"mention",
				"hashtag",
				"emojiCode",
				"link",
				"url",
				"search",
				"text"
			]);
		},
		simple: (r) => {
			return choose(r, [
				"unicodeEmoji",
				"emojiCode",
				"plainTag",
				"text"
			]);
		},
		inline: (r) => {
			return choose(r, [
				"unicodeEmoji",
				"smallTag",
				"plainTag",
				"boldTag",
				"italicTag",
				"strikeTag",
				"urlAlt",
				"big",
				"boldAsta",
				"italicAsta",
				"boldUnder",
				"italicUnder",
				"inlineCode",
				"mathInline",
				"strikeWave",
				"fn",
				"mention",
				"hashtag",
				"emojiCode",
				"link",
				"url",
				"text"
			]);
		},
		quote: (r) => {
			const lines = seq(str(">"), space.option(), seq(notMatch(newLine), char).select(1).many(0).text()).select(2).sep(newLine, 1);
			const parser = seq(newLine.option(), newLine.option(), lineBegin, lines, newLine.option(), newLine.option()).select(3);
			return new Parser((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) return result;
				const contents = result.value;
				const quoteIndex = result.index;
				if (contents.length === 1 && contents[0] === "") return failure();
				result = nest(r.fullParser).many(0).handler(contents.join("\n"), 0, state);
				if (!result.success) return result;
				return success(quoteIndex, QUOTE(mergeText(result.value)));
			});
		},
		codeBlock: () => {
			const mark = str("```");
			return seq(newLine.option(), lineBegin, mark, seq(notMatch(newLine), char).select(1).many(0), newLine, seq(notMatch(seq(newLine, mark, lineEnd)), char).select(1).many(1), newLine, mark, lineEnd, newLine.option()).map((result) => {
				const lang = result[3].join("").trim();
				const code = result[5].join("");
				return CODE_BLOCK(code, lang.length > 0 ? lang : null);
			});
		},
		mathBlock: () => {
			const open = str("\\[");
			const close = str("\\]");
			return seq(newLine.option(), lineBegin, open, newLine.option(), scanThen(seq(notMatch(seq(newLine.option(), close)), char).select(1), 1, seq(newLine.option(), close, lineEnd, newLine.option()))).map((result) => {
				const formula = result[4][0].join("");
				return MATH_BLOCK(formula);
			});
		},
		centerTag: (r) => {
			const open = str("<center>");
			const close = str("</center>");
			return seq(newLine.option(), lineBegin, open, newLine.option(), scanThen(seq(notMatch(seq(newLine.option(), close)), nest(r.inline)).select(1), 1, seq(newLine.option(), close, lineEnd, newLine.option()))).map((result) => {
				return CENTER(mergeText(result[4][0]));
			});
		},
		big: (r) => {
			const mark = str("***");
			return seqOrText(mark, seq(notMatch(mark), nest(r.inline)).select(1).many(1), mark).map((result) => {
				if (typeof result === "string") return result;
				return FN("tada", {}, mergeText(result[1]));
			});
		},
		boldAsta: (r) => {
			const mark = str("**");
			return seqOrText(mark, seq(notMatch(mark), nest(r.inline)).select(1).many(1), mark).map((result) => {
				if (typeof result === "string") return result;
				return BOLD(mergeText(result[1]));
			});
		},
		boldTag: (r) => {
			const open = str("<b>");
			const close = str("</b>");
			return seqOrText(open, seq(notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === "string") return result;
				return BOLD(mergeText(result[1]));
			});
		},
		boldUnder: () => {
			const mark = str("__");
			return seq(mark, alt([alphaAndNum, space]).many(1), mark).map((result) => BOLD(mergeText(result[1])));
		},
		smallTag: (r) => {
			const open = str("<small>");
			const close = str("</small>");
			return seqOrText(open, seq(notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === "string") return result;
				return SMALL(mergeText(result[1]));
			});
		},
		italicTag: (r) => {
			const open = str("<i>");
			const close = str("</i>");
			return seqOrText(open, seq(notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === "string") return result;
				return ITALIC(mergeText(result[1]));
			});
		},
		italicAsta: () => {
			const mark = str("*");
			const parser = seq(mark, alt([alphaAndNum, space]).many(1), mark);
			return new Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) return failure();
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) return failure();
				return success(result.index, ITALIC(mergeText(result.value[1])));
			});
		},
		italicUnder: () => {
			const mark = str("_");
			const parser = seq(mark, alt([alphaAndNum, space]).many(1), mark);
			return new Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) return failure();
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) return failure();
				return success(result.index, ITALIC(mergeText(result.value[1])));
			});
		},
		strikeTag: (r) => {
			const open = str("<s>");
			const close = str("</s>");
			return seqOrText(open, seq(notMatch(close), nest(r.inline)).select(1).many(1), close).map((result) => {
				if (typeof result === "string") return result;
				return STRIKE(mergeText(result[1]));
			});
		},
		strikeWave: (r) => {
			const mark = str("~~");
			return seqOrText(mark, seq(notMatch(alt([mark, newLine])), nest(r.inline)).select(1).many(1), mark).map((result) => {
				if (typeof result === "string") return result;
				return STRIKE(mergeText(result[1]));
			});
		},
		unicodeEmoji: () => {
			return regexp(RegExp(emojiRegex.source)).map((content) => {
				return content === "️" ? content : UNI_EMOJI(content);
			});
		},
		plainTag: () => {
			const open = str("<plain>");
			const close = str("</plain>");
			return seq(open, newLine.option(), scanThen(seq(notMatch(seq(newLine.option(), close)), char).select(1), 1, seq(newLine.option(), close))).select(2).map((result) => PLAIN(result[0].join("")));
		},
		fn: (r) => {
			const fnName = regexp(/[a-z0-9_]+/i);
			const arg = seq(regexp(/[a-z0-9_]+/i), seq(str("="), regexp(/[a-z0-9_.-]+/i)).select(1).option()).map((result) => {
				return {
					k: result[0],
					v: result[1] != null ? result[1] : true
				};
			});
			const args = seq(str("."), arg.sep(str(","), 1)).select(1).map((pairs) => {
				const result = {};
				for (const pair of pairs) result[pair.k] = pair.v;
				return result;
			});
			const fnClose = str("]");
			return seqOrText(str("$["), fnName, args.option(), str(" "), seq(notMatch(fnClose), nest(r.inline)).select(1).many(1), fnClose).map((result) => {
				if (typeof result === "string") return result;
				const name = result[1];
				const args = result[2] || {};
				const content = result[4];
				return FN(name, args, mergeText(content));
			});
		},
		inlineCode: () => {
			const mark = str("`");
			return seq(mark, seq(notMatch(alt([
				mark,
				str("´"),
				newLine
			])), char).select(1).many(1), mark).map((result) => INLINE_CODE(result[1].join("")));
		},
		mathInline: () => {
			const open = str("\\(");
			const close = str("\\)");
			return seq(open, scanThen(seq(notMatch(alt([close, newLine])), char).select(1), 1, close)).map((result) => MATH_INLINE(result[1][0].join("")));
		},
		mention: () => {
			const parser = seq(notLinkLabel, str("@"), regexp(/[a-z0-9_.-]+/i), seq(str("@"), regexp(/[a-z0-9_.-]+/i)).select(1).option());
			return new Parser((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) return failure();
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) return failure();
				let invalidMention = false;
				const resultIndex = result.index;
				const username = result.value[2];
				const hostname = result.value[3];
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
					if (modifiedHost == null) modifiedName = username.slice(0, -1 * result[0].length);
					else invalidMention = true;
				}
				if (modifiedName.length === 0 || /^[.-]/.test(modifiedName)) invalidMention = true;
				if (modifiedHost != null && /^[.-]/.test(modifiedHost)) invalidMention = true;
				if (invalidMention) return success(resultIndex, input.slice(index, resultIndex));
				const acct = modifiedHost != null ? `@${modifiedName}@${modifiedHost}` : `@${modifiedName}`;
				return success(index + acct.length, MENTION(modifiedName, modifiedHost, acct));
			});
		},
		hashtag: () => {
			const mark = str("#");
			const hashTagChar = seq(notMatch(alt([
				regexp(/[ \u3000\t.,!?'"#:/[\]【】()「」（）<>]/),
				space,
				newLine
			])), char).select(1);
			const innerItem = lazy(() => alt([
				seq(str("("), nest(innerItem, hashTagChar).many(0), str(")")),
				seq(str("["), nest(innerItem, hashTagChar).many(0), str("]")),
				seq(str("「"), nest(innerItem, hashTagChar).many(0), str("」")),
				seq(str("（"), nest(innerItem, hashTagChar).many(0), str("）")),
				hashTagChar
			]));
			const parser = seq(notLinkLabel, mark, innerItem.many(1).text()).select(2);
			return new Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) return failure();
				if (index > 0 && /[a-z0-9]/i.test(input.charAt(index - 1))) return failure();
				const resultIndex = result.index;
				const resultValue = result.value;
				if (/^[0-9]+$/.test(resultValue)) return failure();
				return success(resultIndex, HASHTAG(resultValue));
			});
		},
		emojiCode: () => {
			const side = notMatch(regexp(/[a-z0-9]/i));
			const mark = str(":");
			return seq(alt([lineBegin, side]), mark, regexp(/[a-z0-9_+-]+/i), mark, alt([lineEnd, side])).select(2).map((name) => EMOJI_CODE(name));
		},
		link: (r) => {
			const labelInline = new Parser((input, index, state) => {
				state.linkLabel = true;
				const result = r.inline.handler(input, index, state);
				state.linkLabel = false;
				return result;
			});
			const closeLabel = str("]");
			const target = seq(closeLabel, str("("), alt([r.urlAlt, r.url]), str(")"));
			const urlTarget = new Parser((input, index, state) => {
				const result = target.handler(input, index, state);
				if (!result.success || typeof result.value[2] === "string") return failure();
				return success(result.index, result.value[2]);
			});
			return seq(notLinkLabel, alt([str("?["), str("[")]), scanThen(seq(notMatch(alt([closeLabel, newLine])), nest(labelInline)).select(1), 1, urlTarget)).map(([, prefix, [label, url]]) => LINK(prefix === "?[", url.props.url, mergeText(label)));
		},
		url: () => {
			const urlChar = regexp(/[.,a-z0-9_/:%#@$&?!~=+-]/i);
			const innerItem = lazy(() => alt([
				seq(str("("), nest(innerItem, urlChar).many(0), str(")")),
				seq(str("["), nest(innerItem, urlChar).many(0), str("]")),
				urlChar
			]));
			const parser = seq(notLinkLabel, regexp(/https?:\/\//), innerItem.many(1).text());
			return new Parser((input, index, state) => {
				let result;
				result = parser.handler(input, index, state);
				if (!result.success) return failure();
				const resultIndex = result.index;
				let modifiedIndex = resultIndex;
				const schema = result.value[1];
				let content = result.value[2];
				result = /[.,]+$/.exec(content);
				if (result != null) {
					modifiedIndex -= result[0].length;
					content = content.slice(0, -1 * result[0].length);
					if (content.length === 0) return success(resultIndex, input.slice(index, resultIndex));
				}
				return success(modifiedIndex, N_URL(schema + content, false));
			});
		},
		urlAlt: () => {
			const open = str("<");
			const close = str(">");
			const parser = seq(notLinkLabel, open, regexp(/https?:\/\//), scanThen(seq(notMatch(alt([close, space])), char).select(1), 1, close)).text();
			return new Parser((input, index, state) => {
				const result = parser.handler(input, index, state);
				if (!result.success) return failure();
				const text = result.value.slice(1, -1);
				return success(result.index, N_URL(text, true));
			});
		},
		search: () => {
			const button = alt([regexp(/\[(検索|search)\]/i), regexp(/(検索|search)/i)]);
			const lineTail = /[\u0020\u3000\t](?:\[(?:検索|search)\]|検索|search)$/i;
			const parser = seq(newLine.option(), lineBegin, seq(notMatch(alt([newLine, seq(space, button, lineEnd)])), char).select(1).many(1), space, button, lineEnd, newLine.option()).map((result) => {
				const query = result[2].join("");
				return SEARCH(query, `${query}${result[3]}${result[4]}`);
			});
			if (!opts.optimizations) return parser;
			return new Parser((input, index, state) => {
				let lineStart = index;
				if (input.startsWith("\r\n", lineStart)) lineStart += 2;
				else if (input[lineStart] === "\r" || input[lineStart] === "\n") lineStart += 1;
				if (lineStart > 0 && input[lineStart - 1] !== "\n" && input[lineStart - 1] !== "\r") return failure();
				let lineEnd = lineStart;
				while (lineEnd < input.length && input[lineEnd] !== "\r" && input[lineEnd] !== "\n") lineEnd++;
				if (!lineTail.test(input.slice(lineStart, lineEnd))) return failure();
				return parser.handler(input, index, state);
			});
		},
		text: () => char
	});
}
const language = createMfmLanguage({ optimizations: true });
//#endregion
//#region src/internal/index.ts
function fullParser(input, opts) {
	const result = language.fullParser.handler(input, 0, {
		nestLimit: opts.nestLimit != null ? opts.nestLimit : 20,
		depth: 0,
		linkLabel: false,
		trace: false
	});
	if (!result.success) throw new Error("Unexpected parse error");
	return mergeText(result.value);
}
function simpleParser(input) {
	const result = language.simpleParser.handler(input, 0, {
		depth: 0,
		nestLimit: 1 / 0
	});
	if (!result.success) throw new Error("Unexpected parse error");
	return mergeText(result.value);
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