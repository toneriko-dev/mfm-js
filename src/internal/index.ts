import type * as M from '../node';
import { parseFull, parseSimple } from './parser';

export type FullParserOpts = {
	nestLimit?: number;
};

export function fullParser(input: string, opts: FullParserOpts): M.MfmNode[] {
	return parseFull(input, opts.nestLimit != null ? opts.nestLimit : 20);
}

export function simpleParser(input: string): M.MfmSimpleNode[] {
	return parseSimple(input);
}
