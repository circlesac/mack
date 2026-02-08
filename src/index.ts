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

	// Slack only wants &, <, and > escaped
	// https://api.slack.com/reference/surfaces/formatting#escaping
	const replacements: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;"
	}

	const lexer = new marked.Lexer()

	// Override inlineText to escape &, <, > for Slack while preserving
	// the default raw-consumption behavior (so inline formatting like
	// **bold** and _italic_ continues to be parsed correctly).
	// We use the default regex to determine how much text to consume,
	// then apply Slack-specific escaping (only &, <, >) on the raw text
	// instead of marked's default escape() which also escapes " and '.
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
		const text = raw.replace(/[&<>]/g, (char: string) => replacements[char])
		return { type: "text", raw, text }
	}

	const tokens = lexer.lex(body)

	// Restore the original inlineText to avoid polluting marked.defaults
	tokenizer.inlineText = origInlineText

	const blocks = parseBlocks(tokens, options)

	validateBlockCount(blocks.length, MAX_BLOCKS)

	return blocks
}
