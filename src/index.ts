import type { KnownBlock } from "@slack/types"
import { marked } from "marked"
import { escapeMarkdownCodeForSlackText } from "./escape"
import { parseBlocks } from "./parser/internal"
import type { RichTextBlock, TableBlock, VideoBlock } from "./slack"
import type { ParsingOptions } from "./types"
import { MAX_BLOCKS, validateBlockCount, validateInput } from "./validation"

export { BlockLimitError, MackError, ParseError, SecurityError, ValidationError } from "./errors"
export type {
	ColumnSetting,
	RichTextBlock,
	RichTextBroadcastElement,
	RichTextChannelElement,
	RichTextDateElement,
	RichTextElement,
	RichTextEmojiElement,
	RichTextLinkElement,
	RichTextListElement,
	RichTextPreformattedElement,
	RichTextQuoteElement,
	RichTextSectionElement,
	RichTextStyle,
	RichTextTextElement,
	RichTextUserElement,
	RichTextUsergroupElement,
	TableBlock,
	TableCell,
	TableRow,
	VideoBlock,
	VideoBlockOptions
} from "./slack"
export type { ListOptions, ParsingOptions } from "./types"
export { escapeMarkdownCodeForSlackText }

/**
 * Parses Markdown content into Slack BlockKit Blocks.
 * - Supports headings (all Markdown heading levels are treated as the single Slack header block)
 * - Supports numbered lists, bulleted lists, to-do lists (as rich_text_list blocks)
 * - Supports italics, bold, strikethrough, inline code, hyperlinks
 * - Supports images
 * - Supports thematic breaks / dividers
 * - Supports code blocks (as rich_text_preformatted blocks)
 * - Supports blockquotes (as rich_text_quote blocks for simple quotes)
 * - Supports native table blocks with rich text formatting and column alignment
 *
 * Supports GitHub-flavoured Markdown.
 *
 * @param body any Markdown or GFM content
 * @param options options to configure the parser
 */
export async function markdownToBlocks(body: string, options: ParsingOptions = {}): Promise<(KnownBlock | TableBlock | RichTextBlock | VideoBlock)[]> {
	validateInput(body)

	const lexer = new marked.Lexer({ ...marked.defaults, mangle: false })

	// Override inlineText to prevent marked's default HTML entity escaping.
	// We want raw text so that:
	// 1. Rich text elements (lists, blockquotes, tables) contain unescaped text
	// 2. Slack special formatting (<@USER>, <!here>, etc.) can be matched with simple regex
	// 3. Only the mrkdwn code path escapes &, <, > (via escapeForMrkdwn)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tokenizer = (lexer as any).tokenizer
	const origInlineText = tokenizer.inlineText
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tokenizer.inlineText = function (this: any, src: string) {
		const cap = this.rules.inline.text.exec(src)
		if (!cap) {
			return undefined
		}
		const raw: string = cap[0]
		// Return raw text without escaping (escaping happens downstream in parseMrkdwn)
		return { type: "text", raw, text: raw }
	}

	// Override codespan to prevent marked's HTML entity escaping of code content.
	// marked escapes ", ', &, <, > inside code spans which causes double-encoding
	// when our mrkdwn escaping runs later (e.g. " → &quot; → &amp;quot;).
	const origCodespan = tokenizer.codespan
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tokenizer.codespan = function (this: any, src: string) {
		const cap = this.rules.inline.code.exec(src)
		if (!cap) {
			return undefined
		}
		let text = cap[2].replace(/\n/g, " ")
		const hasNonSpaceChars = /[^ ]/.test(text)
		const hasSpaceCharsOnBothEnds = text.startsWith(" ") && text.endsWith(" ")
		if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
			text = text.substring(1, text.length - 1)
		}
		// Return raw text without HTML escaping
		return { type: "codespan", raw: cap[0], text }
	}

	const tokens = lexer.lex(body)

	// Restore overridden tokenizers to avoid polluting marked.defaults
	tokenizer.inlineText = origInlineText
	tokenizer.codespan = origCodespan

	const blocks = parseBlocks(tokens, options)

	addDividerSpacing(blocks)

	validateBlockCount(blocks.length, MAX_BLOCKS)

	return blocks
}

/**
 * Produces a Slack `chat.postMessage.text` fallback from Markdown.
 *
 * Slack also scans the top-level `text` fallback for mention tokens even when
 * Block Kit is present. Markdown code spans/fences are literal text, so Slack
 * control tokens inside code must be entity-escaped here while real mentions
 * outside code remain intact.
 */
export function markdownToSlackText(body: string): string {
	validateInput(body)
	return escapeMarkdownCodeForSlackText(body)
}

/**
 * Adds breathing room above each divider. A block rendered directly before a
 * divider otherwise sits flush against the rule.
 *
 * Where possible the blank line is appended in place (a trailing newline inside
 * the preceding rich_text or section block), mirroring hand-built Block Kit
 * messages. Blocks that can't carry a trailing newline (table, image, video)
 * instead get a minimal blank-line spacer block inserted before the divider.
 */
function addDividerSpacing(blocks: (KnownBlock | TableBlock | RichTextBlock | VideoBlock)[]): void {
	// Iterate from the end so inserted spacer blocks don't shift indices we
	// have yet to visit.
	for (let i = blocks.length - 1; i >= 1; i--) {
		if (blocks[i].type !== "divider") continue
		const prev = blocks[i - 1]
		if (prev.type === "rich_text") {
			const rt = prev as RichTextBlock
			const last = rt.elements[rt.elements.length - 1]
			if (last && last.type === "rich_text_section") {
				last.elements.push({ type: "text", text: "\n" })
			} else {
				rt.elements.push({ type: "rich_text_section", elements: [{ type: "text", text: "\n" }] })
			}
		} else if (prev.type === "section") {
			const sec = prev as { text?: { text?: string } }
			if (sec.text && typeof sec.text.text === "string" && !sec.text.text.endsWith("\n")) {
				sec.text.text += "\n"
			}
		} else if (prev.type === "table" || prev.type === "image" || prev.type === "video") {
			blocks.splice(i, 0, {
				type: "rich_text",
				elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "\n" }] }]
			} as RichTextBlock)
		}
	}
}
