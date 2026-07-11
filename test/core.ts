import { describe, expect, test } from 'vitest';
import { Parser, success } from '../src/internal/core/index.js';

describe('Parser combinators', () => {
	describe('many', () => {
		test('rejects a parser that succeeds without consuming input', () => {
			const zeroWidthParser = new Parser((_input, index) => success(index, null));
			const parser = zeroWidthParser.many(0);

			expect(() => parser.handler('x', 0, {
				depth: 0,
				nestLimit: 20,
			})).toThrow('must consume at least one character');
		});
	});
});
