import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { createMfmLanguage } from '../src/internal/parser';
import { mergeText } from '../src/internal/util';

// 表引きで text を先に返す経路・検索構文の行末判定と、全構文を順に試す元の文法とで出力が一致することを確かめる。
const reference = createMfmLanguage({ optimizations: false });
const optimized = createMfmLanguage({ optimizations: true });

type Language = ReturnType<typeof createMfmLanguage>;

function full(language: Language, input: string, nestLimit: number) {
	const result = language.fullParser.handler(input, 0, { nestLimit, depth: 0, linkLabel: false, trace: false });
	if (!result.success) throw new Error('parse failed');
	return mergeText(result.value);
}

function simple(language: Language, input: string) {
	const result = language.simpleParser.handler(input, 0, {
		nestLimit: 1 / 0,
		depth: 0,
		linkLabel: false,
		trace: false,
	});
	if (!result.success) throw new Error('parse failed');
	return mergeText(result.value);
}

// 構文の開始・終了記号、行頭でだけ成立する構文、表で普通の文字とする ] や文字種の境界を混ぜる。
const fragments = [
	'a',
	'Z',
	'1',
	'9',
	'_',
	'h',
	'x',
	' ',
	'\u3000',
	'\t',
	'.',
	',',
	'-',
	'!',
	'?',
	'/',
	'=',
	'(',
	')',
	']',
	'[',
	'\n',
	'\r',
	'\r\n',
	'あ',
	'漢',
	'、',
	'。',
	'「',
	'」',
	'（',
	'）',
	'【',
	'】',
	'http://',
	'https://',
	'https://example.com/a_b?c=d#e',
	'httpx',
	'ttps://',
	'@',
	'@a',
	'@a_b',
	'@a@b.c',
	'@a-',
	'@.a',
	'#',
	'#tag',
	'#123',
	'#(a)',
	':',
	':e:',
	':a+b-c:',
	'::',
	'*',
	'**',
	'***',
	'_',
	'__',
	'`',
	'```',
	'```js\n',
	'´',
	'\\',
	'\\(',
	'\\)',
	'\\[',
	'\\]',
	'~',
	'~~',
	'$',
	'$[',
	'$[x2 ',
	'$[fn.a=b,c ',
	'$[f.x ',
	'<',
	'>',
	'> ',
	'<b>',
	'</b>',
	'<i>',
	'</i>',
	'<s>',
	'</s>',
	'<small>',
	'</small>',
	'<center>',
	'</center>',
	'<plain>',
	'</plain>',
	'<https://a.b/c>',
	'?[',
	'[a](https://x.y)',
	'?[b](<https://x.y>)',
	' 検索',
	' search',
	' [search]',
	' [検索]',
	'検索',
	'Search',
	'abc 検索',
	'query text search\n',
	'\nabc 検索',
	'\rq [search]',
	'q\t検索',
	'q\u3000search',
	'q\u3000[検索]\n',
	'q\t[Search]',
	'😀',
	'👍🏽',
	'👨\u200d👩\u200d👧',
	'1\ufe0f\u20e3',
	'#\ufe0f\u20e3',
	'*\ufe0f\u20e3',
	'©\ufe0f',
	'®',
	'™\ufe0f',
	'♟\ufe0f',
	'〰',
	'〽\ufe0f',
	'㊗\ufe0f',
	'\ufe0f',
	'\ufe0e',
	'\u200d',
	'\u20e3',
	'🇯🇵',
	'🏳\ufe0f\u200d🌈',
	'\ud83d',
	'\ude00',
	'\ue50a',
];

const mfmText = fc
	.array(
		fc.oneof(
			{ weight: 6, arbitrary: fc.constantFrom(...fragments) },
			{ weight: 1, arbitrary: fc.string({ maxLength: 4 }) },
		),
		{
			maxLength: 40,
		},
	)
	.map((parts) => parts.join(''));

const rawUnits = fc.string({ unit: 'binary', maxLength: 30 });

// 失敗時の最小化は長くかかるので行わない。反例は最初に見つかった入力をそのまま表示する。
fc.configureGlobal({ endOnFailure: true });

describe('parser fast paths', () => {
	test('full parser output matches the reference grammar', () => {
		fc.assert(
			fc.property(mfmText, fc.integer({ min: 0, max: 4 }), (input, nestLimit) => {
				expect(full(optimized, input, nestLimit)).toEqual(full(reference, input, nestLimit));
			}),
			{ numRuns: 20000 },
		);
	});

	test('full parser output matches on arbitrary UTF-16 code units', () => {
		fc.assert(
			fc.property(rawUnits, (input) => {
				expect(full(optimized, input, 20)).toEqual(full(reference, input, 20));
			}),
			{ numRuns: 5000 },
		);
	});

	test('simple parser output matches the reference grammar', () => {
		fc.assert(
			fc.property(fc.oneof(mfmText, rawUnits), (input) => {
				expect(simple(optimized, input)).toEqual(simple(reference, input));
			}),
			{ numRuns: 10000 },
		);
	});

	test('nested closers after a plain run are still recognized', () => {
		for (const input of [
			'$[x2 abc]def',
			'$[x2 ]abc]',
			'[label text](https://x.y) tail',
			'**bold text**tail',
			'<b>bold text</b>tail',
			'~~strike text~~tail',
			'a ***big text*** b',
			'<center>\ncentered text\n</center>',
			'x\nabc 検索',
			'x\r\nquery text [search]\ny',
			'x\n> quote',
			'x\n```\ncode\n```',
		]) {
			expect(full(optimized, input, 20)).toEqual(full(reference, input, 20));
		}
	});
});
