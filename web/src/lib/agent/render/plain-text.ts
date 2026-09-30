import type { ChatMessage } from '../types';
import { parseMarkdown, type MdBlockNode, type MdInlineNode } from './markdown';

function inline(nodes: readonly MdInlineNode[]): string {
	return nodes
		.map((n) => {
			switch (n.kind) {
				case 'text':
				case 'code':
					return n.text;
				case 'strong':
				case 'em':
				case 'del':
				case 'link':
					return inline(n.children);
				case 'image':
					return n.alt;
				case 'break':
					return '\n';
			}
		})
		.join('');
}

function block(node: MdBlockNode): string {
	switch (node.kind) {
		case 'paragraph':
		case 'heading':
			return inline(node.children);
		case 'code':
		case 'plain':
			return node.text;
		case 'quote':
			return plainText(node.children);
		case 'list':
			return node.items.map((item) => item.children.map(block).join('\n')).join('\n');
		case 'table':
			return [node.head, ...node.rows].map((row) => row.map(inline).join('\t')).join('\n');
		case 'rule':
			return '';
	}
}

/** The rendered text of a markdown tree, with no markdown syntax. */
export function plainText(nodes: readonly MdBlockNode[]): string {
	return nodes
		.map(block)
		.filter((s) => s !== '')
		.join('\n\n');
}

/** What "Copy text" puts on the clipboard: agent text as rendered, your own text as typed. */
export function messagePlainText(message: ChatMessage, origin?: string): string {
	const imageIds = (message.uploads ?? []).filter((f) => f.inline).map((f) => f.id);
	return message.parts
		.flatMap((p) => {
			if (p.type !== 'text') return [];
			if (message.role === 'user') return [p.text];
			return [plainText(parseMarkdown(p.text, { origin, imageIds }))];
		})
		.join('\n\n');
}

export function hasText(message: ChatMessage): boolean {
	return message.parts.some((p) => p.type === 'text' && p.text.trim() !== '');
}
