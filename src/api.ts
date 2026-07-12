import { fullParser, simpleParser } from './internal';
import { inspectOne, stringifyNode, stringifyTree } from './internal/util';
import { MfmMention, MfmNode, MfmSimpleNode } from './node';

/**
 * Generates a MfmNode tree from the MFM string.
 */
export function parse(input: string, opts: Partial<{ nestLimit: number }> = {}): MfmNode[] {
	const nodes = fullParser(
		input,
		opts.nestLimit === undefined
			? {}
			: {
					nestLimit: opts.nestLimit,
				},
	);
	return nodes;
}

/**
 * Generates a MfmSimpleNode tree from the MFM string.
 */
export function parseSimple(input: string): MfmSimpleNode[] {
	const nodes = simpleParser(input);
	return nodes;
}

/**
 * Generates a MFM string from the MfmNode tree.
 */
export function toString(tree: MfmNode[]): string;
export function toString(node: MfmNode): string;
export function toString(node: MfmNode | MfmNode[]): string {
	if (Array.isArray(node)) {
		return stringifyTree(node);
	} else {
		return stringifyNode(node);
	}
}

/**
 * Inspects the MfmNode tree.
 */
export function inspect(node: MfmNode, action: (node: MfmNode) => void): void;
export function inspect(nodes: MfmNode[], action: (node: MfmNode) => void): void;
export function inspect(node: MfmNode | MfmNode[], action: (node: MfmNode) => void): void {
	if (Array.isArray(node)) {
		for (const n of node) {
			inspectOne(n, action);
		}
	} else {
		inspectOne(node, action);
	}
}

/**
 * Inspects the MfmNode tree and returns as an array the nodes that match the conditions
 * of the predicate function.
 */
export function extract(nodes: MfmNode[], predicate: (node: MfmNode) => boolean): MfmNode[] {
	const dest = [] as MfmNode[];

	inspect(nodes, (node) => {
		if (predicate(node)) {
			dest.push(node);
		}
	});

	return dest;
}

/**
 * Extracts unique mentions while preserving their first appearance order.
 * Usernames and hostnames are compared case-insensitively.
 */
export function extractMentions(nodes: MfmNode[]): MfmMention['props'][] {
	const mentions: MfmMention['props'][] = [];
	const seen = new Set<string>();

	inspect(nodes, (node) => {
		if (node.type !== 'mention') return;

		const key = `${node.props.username.toLowerCase()}@${node.props.host?.toLowerCase() ?? ''}`;
		if (seen.has(key)) return;

		seen.add(key);
		mentions.push(node.props);
	});

	return mentions;
}
