import type { MfmInline, MfmNode, MfmText } from '../../src/node';
import { TEXT } from '../../src/node';

type ArrayRecursive<T> = T | ArrayRecursive<T>[];

export function mergeText<T extends MfmNode>(
	nodes: ArrayRecursive<(T extends MfmInline ? MfmInline : MfmNode) | string>[],
): (T | MfmText)[] {
	const dest: (T | MfmText)[] = [];
	const storedChars: string[] = [];

	function generateText(): void {
		if (storedChars.length > 0) {
			dest.push(TEXT(storedChars.join('')));
			storedChars.length = 0;
		}
	}

	const flatten = nodes.flat(1) as (string | T)[];
	for (const node of flatten) {
		if (typeof node === 'string') {
			storedChars.push(node);
		} else if (!Array.isArray(node) && node.type === 'text') {
			storedChars.push((node as MfmText).props.text);
		} else {
			generateText();
			dest.push(node);
		}
	}
	generateText();

	return dest;
}
