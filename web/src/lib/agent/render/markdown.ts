import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type {
	Definition,
	Nodes,
	PhrasingContent,
	Root,
	RootContent,
	TableCell,
	TableRow
} from 'mdast';
import { fileUrl, UPLOAD_ID_RE } from '$lib/chat/events';
import type { MdBlock } from '../types';

// Every security decision about agent text happens here. markdown.svelte only switches on `kind`
// and interpolates strings, so what is validated is exactly what reaches the DOM.

export type MdInlineNode =
	| { kind: 'text'; text: string }
	| { kind: 'strong' | 'em' | 'del'; children: MdInlineNode[] }
	| { kind: 'code'; text: string }
	/** `href` is the parsed URL's serialization, never the source string. */
	| { kind: 'link'; href: string; children: MdInlineNode[] }
	/** `src` is always `/f/<id>` for an inline image the bot attached to this message. */
	| { kind: 'image'; src: string; alt: string }
	| { kind: 'break' };

export type MdAlign = 'left' | 'right' | 'center' | null;

export type MdBlockNode =
	| { kind: 'paragraph'; children: MdInlineNode[] }
	| { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInlineNode[] }
	| { kind: 'code'; lang: string | null; text: string }
	| { kind: 'quote'; children: MdBlockNode[] }
	| {
			kind: 'list';
			ordered: boolean;
			start: number | null;
			items: { checked: boolean | null; children: MdBlockNode[] }[];
	  }
	| { kind: 'table'; align: MdAlign[]; head: MdInlineNode[][]; rows: MdInlineNode[][][] }
	| { kind: 'rule' }
	/** Unparsed text, shown with its line breaks. */
	| { kind: 'plain'; text: string };

export interface RenderContext {
	/** Upload ids the bot attached to this same message with `inline: true`; only these render as images. */
	imageIds?: Iterable<string>;
	/** The app's own origin. Links to it render as text, like relative links. */
	origin?: string;
}

/** Nesting past this flattens to plain text, so a hostile reply cannot blow the component stack. */
export const MAX_DEPTH = 12;
/** micromark's emphasis resolution is quadratic on delimiter-heavy input (a 20k-char run of `*`
 *  takes seconds), so longer text renders unparsed rather than freezing the chat. */
export const MARKDOWN_PARSE_MAX = 16_000;

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const FILE_PATH_RE = /^\/f\/([A-Za-z0-9_-]{22})$/;

/** The serialized URL when `raw` is an absolute http(s)/mailto URL off this origin; null otherwise. */
export function safeHref(raw: string, origin?: string): string | null {
	let url: URL;
	try {
		// No base: relative and protocol-relative links fail to parse and render as text.
		url = new URL(raw);
	} catch {
		return null;
	}
	if (!LINK_PROTOCOLS.has(url.protocol)) return null;
	if (url.protocol !== 'mailto:' && origin && sameHost(url, origin)) return null;
	return url.href;
}

// Any scheme or port on the app's own host, including the trailing-dot FQDN form, counts as the app.
function sameHost(url: URL, origin: string): boolean {
	const bare = (host: string) => host.replace(/\.$/, '').toLowerCase();
	try {
		return bare(url.hostname) === bare(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** `/f/<id>` for a source that names one of the allowed inline uploads exactly; null otherwise. */
export function safeImageSrc(raw: string, imageIds: ReadonlySet<string>): string | null {
	const id = FILE_PATH_RE.exec(raw)?.[1];
	return id && UPLOAD_ID_RE.test(id) && imageIds.has(id) ? fileUrl(id) : null;
}

class Renderer {
	private readonly definitions = new Map<string, Definition>();
	private readonly imageIds: ReadonlySet<string>;
	private readonly origin: string | undefined;

	constructor(root: Root, ctx: RenderContext) {
		this.imageIds = new Set(ctx.imageIds ?? []);
		this.origin = ctx.origin;
		const stack: Nodes[] = [root];
		while (stack.length) {
			const node = stack.pop()!;
			if (node.type === 'definition' && !this.definitions.has(node.identifier)) {
				this.definitions.set(node.identifier, node);
			}
			if ('children' in node) stack.push(...node.children);
		}
	}

	blocks(nodes: readonly RootContent[], depth: number): MdBlockNode[] {
		return nodes.flatMap((node) => this.block(node, depth));
	}

	private block(node: RootContent, depth: number): MdBlockNode[] {
		if (depth > MAX_DEPTH) return [paragraphOf(plainText(node))];
		switch (node.type) {
			case 'paragraph':
				return [{ kind: 'paragraph', children: this.inlines(node.children, depth + 1) }];
			case 'heading':
				return [
					{ kind: 'heading', level: node.depth, children: this.inlines(node.children, depth + 1) }
				];
			case 'code':
				return [{ kind: 'code', lang: node.lang ?? null, text: node.value }];
			case 'blockquote':
				return [{ kind: 'quote', children: this.blocks(node.children, depth + 1) }];
			case 'list':
				return [
					{
						kind: 'list',
						ordered: node.ordered === true,
						start: node.ordered && typeof node.start === 'number' ? node.start : null,
						items: node.children.map((item) => ({
							checked: typeof item.checked === 'boolean' ? item.checked : null,
							children: this.blocks(item.children, depth + 1)
						}))
					}
				];
			case 'table': {
				const [head, ...rows] = node.children;
				const cells = (row: TableRow | undefined) =>
					(row?.children ?? []).map((cell: TableCell) => this.inlines(cell.children, depth + 1));
				return [
					{
						kind: 'table',
						align: (node.align ?? []).map((a) => a ?? null),
						head: cells(head),
						rows: rows.map(cells)
					}
				];
			}
			case 'thematicBreak':
				return [{ kind: 'rule' }];
			case 'html':
				return [paragraphOf(node.value)];
			case 'definition':
				return [];
			case 'footnoteDefinition':
				return [
					paragraphOf(`[^${node.label ?? node.identifier}]:`),
					...this.blocks(node.children, depth + 1)
				];
			default:
				return [paragraphOf(plainText(node))];
		}
	}

	inlines(nodes: readonly PhrasingContent[], depth: number): MdInlineNode[] {
		const out: MdInlineNode[] = [];
		for (const node of nodes) {
			for (const inline of this.inline(node, depth)) {
				const last = out.at(-1);
				if (inline.kind === 'text' && last?.kind === 'text') last.text += inline.text;
				else out.push(inline);
			}
		}
		return out;
	}

	private inline(node: PhrasingContent, depth: number): MdInlineNode[] {
		if (depth > MAX_DEPTH) return [{ kind: 'text', text: plainText(node) }];
		switch (node.type) {
			case 'text':
				return [{ kind: 'text', text: node.value }];
			case 'strong':
			case 'emphasis':
			case 'delete':
				return [
					{
						kind: node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' : 'del',
						children: this.inlines(node.children, depth + 1)
					}
				];
			case 'inlineCode':
				return [{ kind: 'code', text: node.value }];
			case 'break':
				return [{ kind: 'break' }];
			case 'html':
				return [{ kind: 'text', text: node.value }];
			case 'link':
				return this.link(node.url, node.children, depth);
			case 'linkReference': {
				const def = this.definitions.get(node.identifier);
				return def
					? this.link(def.url, node.children, depth)
					: this.inlines(node.children, depth + 1);
			}
			case 'image':
				return this.image(node.url, node.alt ?? '', depth);
			case 'imageReference': {
				const def = this.definitions.get(node.identifier);
				return def
					? this.image(def.url, node.alt ?? '', depth)
					: [{ kind: 'text', text: node.alt ?? '' }];
			}
			case 'footnoteReference':
				return [{ kind: 'text', text: `[^${node.label ?? node.identifier}]` }];
			default:
				return [{ kind: 'text', text: plainText(node) }];
		}
	}

	private link(url: string, children: PhrasingContent[], depth: number): MdInlineNode[] {
		const inner = this.inlines(children, depth + 1);
		const href = safeHref(url, this.origin);
		// A link inside a link is invalid HTML; the outer one wins and the inner renders as its text.
		return href ? [{ kind: 'link', href, children: stripLinks(inner) }] : inner;
	}

	private image(url: string, alt: string, depth: number): MdInlineNode[] {
		const src = safeImageSrc(url, this.imageIds);
		if (src) return [{ kind: 'image', src, alt }];
		const label: PhrasingContent[] = [{ type: 'text', value: alt || url }];
		return this.link(url, label, depth);
	}
}

function paragraphOf(text: string): MdBlockNode {
	return { kind: 'paragraph', children: [{ kind: 'text', text }] };
}

function stripLinks(nodes: MdInlineNode[]): MdInlineNode[] {
	return nodes.flatMap((n): MdInlineNode[] => {
		if (n.kind === 'link') return stripLinks(n.children);
		if (n.kind === 'strong' || n.kind === 'em' || n.kind === 'del') {
			return [{ kind: n.kind, children: stripLinks(n.children) }];
		}
		return [n];
	});
}

/** Iterative so an adversarially deep tree cannot overflow the stack here either. */
function plainText(node: Nodes): string {
	const parts: string[] = [];
	const stack: Nodes[] = [node];
	while (stack.length) {
		const n = stack.pop()!;
		if ('value' in n && typeof n.value === 'string') parts.push(n.value);
		else if (n.type === 'image' || n.type === 'imageReference') parts.push(n.alt ?? '');
		else if (n.type === 'break') parts.push('\n');
		if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
	}
	return parts.join('');
}

/** Parses agent markdown (CommonMark + GFM) to a render tree. Raw HTML is kept as literal text. */
export function parseMarkdown(text: string, ctx: RenderContext = {}): MdBlockNode[] {
	if (text.length > MARKDOWN_PARSE_MAX) return [{ kind: 'plain', text }];
	const root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	return new Renderer(root, ctx).blocks(root.children, 0);
}

/** Converts the prototype's pre-parsed blocks, applying the same link rule. */
export function fromLegacyBlocks(
	blocks: readonly MdBlock[],
	ctx: RenderContext = {}
): MdBlockNode[] {
	return blocks.map((block): MdBlockNode => {
		if (block.kind === 'heading') {
			return { kind: 'heading', level: 3, children: [{ kind: 'text', text: block.text }] };
		}
		return {
			kind: 'paragraph',
			children: block.inlines.map((inline): MdInlineNode => {
				if (inline.kind === 'strong') {
					return { kind: 'strong', children: [{ kind: 'text', text: inline.text }] };
				}
				if (inline.kind === 'code') return { kind: 'code', text: inline.text };
				if (inline.kind === 'link') {
					const href = safeHref(inline.href, ctx.origin);
					return href
						? { kind: 'link', href, children: [{ kind: 'text', text: inline.text }] }
						: { kind: 'text', text: inline.text };
				}
				return { kind: 'text', text: inline.text };
			})
		};
	});
}
