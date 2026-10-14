//#region src/node.d.ts
type MfmNode = MfmBlock | MfmInline;
type MfmSimpleNode = MfmUnicodeEmoji | MfmEmojiCode | MfmText | MfmPlain;
type MfmBlock = MfmQuote | MfmSearch | MfmCodeBlock | MfmMathBlock | MfmCenter;
export declare function isMfmBlock(node: MfmNode): node is MfmBlock;
type MfmQuote = {
  type: 'quote';
  props?: Record<string, unknown>;
  children: MfmNode[];
};
export declare const QUOTE: (children: MfmNode[]) => NodeType<'quote'>;
type MfmSearch = {
  type: 'search';
  props: {
    query: string;
    content: string;
  };
  children?: [];
};
export declare const SEARCH: (query: string, content: string) => NodeType<'search'>;
type MfmCodeBlock = {
  type: 'blockCode';
  props: {
    code: string;
    lang: string | null;
  };
  children?: [];
};
export declare const CODE_BLOCK: (code: string, lang: string | null) => NodeType<'blockCode'>;
type MfmMathBlock = {
  type: 'mathBlock';
  props: {
    formula: string;
  };
  children?: [];
};
export declare const MATH_BLOCK: (formula: string) => NodeType<'mathBlock'>;
type MfmCenter = {
  type: 'center';
  props?: Record<string, unknown>;
  children: MfmInline[];
};
export declare const CENTER: (children: MfmInline[]) => NodeType<'center'>;
type MfmInline = MfmUnicodeEmoji | MfmEmojiCode | MfmBold | MfmSmall | MfmItalic | MfmStrike | MfmInlineCode | MfmMathInline | MfmMention | MfmHashtag | MfmUrl | MfmLink | MfmFn | MfmPlain | MfmText;
type MfmUnicodeEmoji = {
  type: 'unicodeEmoji';
  props: {
    emoji: string;
  };
  children?: [];
};
export declare const UNI_EMOJI: (value: string) => NodeType<'unicodeEmoji'>;
type MfmEmojiCode = {
  type: 'emojiCode';
  props: {
    name: string;
  };
  children?: [];
};
export declare const EMOJI_CODE: (name: string) => NodeType<'emojiCode'>;
type MfmBold = {
  type: 'bold';
  props?: Record<string, unknown>;
  children: MfmInline[];
};
export declare const BOLD: (children: MfmInline[]) => NodeType<'bold'>;
type MfmSmall = {
  type: 'small';
  props?: Record<string, unknown>;
  children: MfmInline[];
};
export declare const SMALL: (children: MfmInline[]) => NodeType<'small'>;
type MfmItalic = {
  type: 'italic';
  props?: Record<string, unknown>;
  children: MfmInline[];
};
export declare const ITALIC: (children: MfmInline[]) => NodeType<'italic'>;
type MfmStrike = {
  type: 'strike';
  props?: Record<string, unknown>;
  children: MfmInline[];
};
export declare const STRIKE: (children: MfmInline[]) => NodeType<'strike'>;
type MfmInlineCode = {
  type: 'inlineCode';
  props: {
    code: string;
  };
  children?: [];
};
export declare const INLINE_CODE: (code: string) => NodeType<'inlineCode'>;
type MfmMathInline = {
  type: 'mathInline';
  props: {
    formula: string;
  };
  children?: [];
};
export declare const MATH_INLINE: (formula: string) => NodeType<'mathInline'>;
type MfmMention = {
  type: 'mention';
  props: {
    username: string;
    host: string | null;
    acct: string;
  };
  children?: [];
};
export declare const MENTION: (username: string, host: string | null, acct: string) => NodeType<'mention'>;
type MfmHashtag = {
  type: 'hashtag';
  props: {
    hashtag: string;
  };
  children?: [];
};
export declare const HASHTAG: (value: string) => NodeType<'hashtag'>;
type MfmUrl = {
  type: 'url';
  props: {
    url: string;
    brackets?: boolean;
  };
  children?: [];
};
export declare const N_URL: (value: string, brackets?: boolean) => NodeType<'url'>;
type MfmLink = {
  type: 'link';
  props: {
    silent: boolean;
    url: string;
  };
  children: MfmInline[];
};
export declare const LINK: (silent: boolean, url: string, children: MfmInline[]) => NodeType<'link'>;
type MfmFn = {
  type: 'fn';
  props: {
    name: string;
    args: Record<string, string | true>;
  };
  children: MfmInline[];
};
export declare const FN: (name: string, args: MfmFn['props']['args'], children: MfmFn['children']) => NodeType<'fn'>;
type MfmPlain = {
  type: 'plain';
  props?: Record<string, unknown>;
  children: MfmText[];
};
export declare const PLAIN: (text: string) => NodeType<'plain'>;
type MfmText = {
  type: 'text';
  props: {
    text: string;
  };
  children?: [];
};
export declare const TEXT: (value: string) => NodeType<'text'>;
type NodeType<T extends MfmNode['type']> = T extends 'quote' ? MfmQuote : T extends 'search' ? MfmSearch : T extends 'blockCode' ? MfmCodeBlock : T extends 'mathBlock' ? MfmMathBlock : T extends 'center' ? MfmCenter : T extends 'unicodeEmoji' ? MfmUnicodeEmoji : T extends 'emojiCode' ? MfmEmojiCode : T extends 'bold' ? MfmBold : T extends 'small' ? MfmSmall : T extends 'italic' ? MfmItalic : T extends 'strike' ? MfmStrike : T extends 'inlineCode' ? MfmInlineCode : T extends 'mathInline' ? MfmMathInline : T extends 'mention' ? MfmMention : T extends 'hashtag' ? MfmHashtag : T extends 'url' ? MfmUrl : T extends 'link' ? MfmLink : T extends 'fn' ? MfmFn : T extends 'plain' ? MfmPlain : T extends 'text' ? MfmText : never;
//#endregion
//#region src/api.d.ts
export declare function parse(input: string, opts?: Partial<{
  nestLimit: number;
}>): MfmNode[];
export declare function parseSimple(input: string): MfmSimpleNode[];
export declare function toString(tree: MfmNode[]): string;
export declare function toString(node: MfmNode): string;
export declare function inspect(node: MfmNode, action: (node: MfmNode) => void): void;
export declare function inspect(nodes: MfmNode[], action: (node: MfmNode) => void): void;
export declare function extract(nodes: MfmNode[], predicate: (node: MfmNode) => boolean): MfmNode[];
export declare function extractMentions(nodes: MfmNode[]): MfmMention['props'][];
//#endregion
export type { MfmBlock, MfmBold, MfmCenter, MfmCodeBlock, MfmEmojiCode, MfmFn, MfmHashtag, MfmInline, MfmInlineCode, MfmItalic, MfmLink, MfmMathBlock, MfmMathInline, MfmMention, MfmNode, MfmPlain, MfmQuote, MfmSearch, MfmSimpleNode, MfmSmall, MfmStrike, MfmText, MfmUnicodeEmoji, MfmUrl, NodeType };
//# sourceMappingURL=index.d.ts.map