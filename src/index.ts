import type { KnownBlock } from "@slack/types"
import { marked } from "marked"
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
		const hasSpaceCharsOnBothEnds = /^ /.test(text) && / $/.test(text)
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

	validateBlockCount(blocks.length, MAX_BLOCKS)

	return blocks
}
