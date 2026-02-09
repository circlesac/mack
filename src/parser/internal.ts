import { DividerBlock, HeaderBlock, ImageBlock, KnownBlock, SectionBlock } from "@slack/types"
import { XMLParser } from "fast-xml-parser"
import { marked } from "marked"
import {
	ColumnSetting,
	divider,
	header,
	image,
	RichTextBlock,
	RichTextElement,
	RichTextSectionElement,
	RichTextStyle,
	richTextCode,
	richTextList,
	richTextQuote,
	section,
	TableBlock,
	TableCell,
	TableRow,
	table,
	VideoBlock,
	video
} from "../slack"
import { ListOptions, ParsingOptions } from "../types"
import { SECURE_XML_CONFIG, validateRecursionDepth, validateUrl } from "../validation"

type PhrasingToken =
	| marked.Tokens.Link
	| marked.Tokens.Em
	| marked.Tokens.Strong
	| marked.Tokens.Del
	| marked.Tokens.Br
	| marked.Tokens.Image
	| marked.Tokens.Codespan
	| marked.Tokens.Text
	| marked.Tokens.HTML
	| marked.Tokens.Escape

let recursionDepth = 0

/**
 * Escapes &, <, > for Slack mrkdwn format.
 * Only used in the section/mrkdwn code path (not rich_text).
 */
function escapeForMrkdwn(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function parsePlainText(element: PhrasingToken): string[] {
	switch (element.type) {
		case "link":
		case "em":
		case "strong":
		case "del":
			return element.tokens.flatMap((child) => parsePlainText(child as PhrasingToken))

		case "br":
			return []

		case "image":
			return [element.title ?? element.href]

		case "codespan":
		case "text":
		case "html":
			return [element.raw]
	}
}

function isSectionBlock(block: KnownBlock): block is SectionBlock {
	return block.type === "section"
}

function parseMrkdwn(element: Exclude<PhrasingToken, marked.Tokens.Image>): string {
	recursionDepth++
	try {
		validateRecursionDepth(recursionDepth)

		switch (element.type) {
			case "link": {
				const href = element.href && validateUrl(element.href) ? element.href : ""
				if (!href) {
					return element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")
				}
				return `<${href}|${element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")}> `
			}

			case "em": {
				return `_${element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")}_`
			}

			case "codespan":
				return `\`${escapeForMrkdwn(element.text)}\``

			case "strong": {
				return `*${element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")}*`
			}

			case "text":
				return escapeForMrkdwn(element.text)

			case "del": {
				return `~${element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")}~`
			}

			default:
				return ""
		}
	} finally {
		recursionDepth--
	}
}

function addMrkdwn(content: string, accumulator: (SectionBlock | ImageBlock)[]) {
	const last = accumulator[accumulator.length - 1]

	if (last && isSectionBlock(last) && last.text) {
		last.text.text += content
	} else {
		accumulator.push(section(content))
	}
}

function parsePhrasingContent(element: PhrasingToken, accumulator: (SectionBlock | ImageBlock)[]) {
	if (element.type === "image") {
		const imageBlock: ImageBlock = image(element.href, element.text || element.title || element.href, element.title)
		accumulator.push(imageBlock)
	} else {
		const text = parseMrkdwn(element)
		addMrkdwn(text, accumulator)
	}
}

function parseParagraph(element: marked.Tokens.Paragraph): KnownBlock[] {
	return element.tokens.reduce(
		(accumulator, child) => {
			parsePhrasingContent(child as PhrasingToken, accumulator)
			return accumulator
		},
		[] as (SectionBlock | ImageBlock)[]
	)
}

function parseHeading(element: marked.Tokens.Heading): HeaderBlock {
	return header(element.tokens.flatMap((child) => parsePlainText(child as PhrasingToken)).join(""))
}

function parseCode(element: marked.Tokens.Code): RichTextBlock {
	return richTextCode(element.text)
}

// --- Rich text helpers ---

function hasStyle(style?: RichTextStyle): boolean {
	return style !== undefined && Object.keys(style).length > 0
}

/**
 * Parses Slack special formatting patterns in text and returns rich text elements.
 * Handles: <@USER_ID>, <#CHANNEL_ID>, <!here>, <!channel>, <!everyone>,
 * <!subteam^TEAM_ID>, <!date^timestamp^format|fallback>, <url|text>
 */
function parseSlackSpecialFormatting(text: string, style?: RichTextStyle): RichTextSectionElement[] {
	const slackPattern = /<(@[A-Z0-9]+(?:\|[^>]+)?|#[A-Z0-9]+(?:\|[^>]+)?|![a-z]+(?:\^[^>]+)*(?:\|[^>]+)?|https?:\/\/[^|>]+\|[^>]+|https?:\/\/[^>]+)>/g

	const elements: RichTextSectionElement[] = []
	let lastIndex = 0
	let match: RegExpExecArray | null

	while ((match = slackPattern.exec(text)) !== null) {
		if (match.index > lastIndex) {
			const beforeText = text.slice(lastIndex, match.index)
			elements.push({ type: "text", text: beforeText, ...(hasStyle(style) && { style }) })
		}

		const content = match[1]

		if (content.startsWith("@")) {
			const [userId] = content.slice(1).split("|")
			elements.push({ type: "user", user_id: userId, ...(hasStyle(style) && { style }) })
		} else if (content.startsWith("#")) {
			const [channelId] = content.slice(1).split("|")
			elements.push({ type: "channel", channel_id: channelId, ...(hasStyle(style) && { style }) })
		} else if (content.startsWith("!")) {
			if (content === "!here") {
				elements.push({ type: "broadcast", range: "here", ...(hasStyle(style) && { style }) })
			} else if (content === "!channel") {
				elements.push({ type: "broadcast", range: "channel", ...(hasStyle(style) && { style }) })
			} else if (content === "!everyone") {
				elements.push({ type: "broadcast", range: "everyone", ...(hasStyle(style) && { style }) })
			} else if (content.startsWith("!subteam^")) {
				const usergroupId = content.slice(9)
				elements.push({ type: "usergroup", usergroup_id: usergroupId, ...(hasStyle(style) && { style }) })
			} else if (content.startsWith("!date^")) {
				const dateContent = content.slice(6)
				const parts = dateContent.split("|")
				const formatParts = (parts[0] || "").split("^")
				const timestamp = parseInt(formatParts[0] || "0", 10)
				const format = formatParts.slice(1).join("^") || "{date_pretty}"
				const fallback = parts[1]
				elements.push({
					type: "date",
					timestamp,
					format,
					...(fallback && { fallback }),
					...(hasStyle(style) && { style })
				})
			} else {
				elements.push({ type: "text", text: match[0], ...(hasStyle(style) && { style }) })
			}
		} else if (content.startsWith("http://") || content.startsWith("https://")) {
			const pipeIndex = content.indexOf("|")
			if (pipeIndex !== -1) {
				elements.push({
					type: "link",
					url: content.slice(0, pipeIndex),
					text: content.slice(pipeIndex + 1),
					...(hasStyle(style) && { style })
				})
			} else {
				elements.push({ type: "link", url: content, ...(hasStyle(style) && { style }) })
			}
		} else {
			elements.push({ type: "text", text: match[0], ...(hasStyle(style) && { style }) })
		}

		lastIndex = match.index + match[0].length
	}

	if (lastIndex < text.length) {
		const afterText = text.slice(lastIndex)
		elements.push({ type: "text", text: afterText, ...(hasStyle(style) && { style }) })
	}

	if (elements.length === 0) {
		return [{ type: "text", text, ...(hasStyle(style) && { style }) }]
	}

	return elements
}

/**
 * Creates a text element with Slack special formatting parsing.
 * Applies soft line break conversion (single \n → space).
 */
function createTextElement(token: marked.Tokens.Text | marked.Tokens.Codespan, style?: RichTextStyle): RichTextSectionElement[] {
	// Soft line breaks: convert single newlines to spaces (standard markdown behavior)
	const text = token.text.replace(/\n(?!\n)/g, " ")

	// Code spans: don't parse Slack formatting (keep as literal text)
	if (token.type === "codespan") {
		return [{ type: "text", text, ...(hasStyle(style) && { style }) }]
	}

	return parseSlackSpecialFormatting(text, style)
}

/**
 * Creates link elements with style propagation and Slack pipe format handling.
 */
function createLinkElements(token: marked.Tokens.Link, childTokens: PhrasingToken[], baseStyle?: RichTextStyle): RichTextSectionElement[] {
	const href = token.href

	// Check for Slack pipe format in href
	const pipeIndex = href.indexOf("|")
	if (pipeIndex !== -1 && pipeIndex > 0) {
		const url = href.slice(0, pipeIndex)
		const linkText = href.slice(pipeIndex + 1)
		return [{ type: "link", url, text: linkText, ...(hasStyle(baseStyle) && { style: baseStyle }) }]
	}

	if (!validateUrl(href)) {
		return processTokensWithStyle(childTokens, baseStyle)
	}

	// Process child tokens recursively for styled link text
	const elements: RichTextSectionElement[] = processTokensWithStyle(childTokens, baseStyle)
		.map((el) => {
			if (el.type === "link") {
				return { type: "text" as const, text: el.text || el.url || "", ...(el.style && { style: el.style }) }
			}
			return el
		})
		.filter((el) => el.type === "text")

	// Group consecutive text elements with the same style into single link elements
	const linkElements: RichTextSectionElement[] = []
	let currentText = ""
	let currentStyle: RichTextStyle | undefined = baseStyle

	for (const el of elements) {
		if (el.type === "text") {
			if (JSON.stringify(el.style) === JSON.stringify(currentStyle)) {
				currentText += el.text
			} else {
				if (currentText) {
					linkElements.push({
						type: "link",
						url: href,
						...(currentText !== href && { text: currentText }),
						...(hasStyle(currentStyle) && { style: currentStyle })
					})
				}
				currentText = el.text
				currentStyle = el.style
			}
		}
	}

	if (currentText) {
		linkElements.push({
			type: "link",
			url: href,
			...(currentText !== href && { text: currentText }),
			...(hasStyle(currentStyle) && { style: currentStyle })
		})
	}

	if (linkElements.length === 0) {
		const fallbackText = token.text || ""
		linkElements.push({
			type: "link",
			url: href,
			...(fallbackText && fallbackText !== href && { text: fallbackText }),
			...(hasStyle(baseStyle) && { style: baseStyle })
		})
	}

	return linkElements
}

/**
 * Recursively converts a single inline token to RichTextSectionElements,
 * accumulating style state through nesting.
 */
function tokenToRichTextElements(token: PhrasingToken, style?: RichTextStyle): RichTextSectionElement[] {
	const hasTokens = "tokens" in token && token.tokens && token.tokens.length > 0

	// Leaf nodes: no nested tokens
	if (!hasTokens) {
		switch (token.type) {
			case "text":
				return createTextElement(token, style)
			case "codespan":
				return createTextElement(token, { ...style, code: true })
			case "br":
				return [{ type: "text", text: "\n", ...(hasStyle(style) && { style }) }]
			case "escape": {
				const escapeToken = token as marked.Tokens.Escape
				// Use raw (minus backslash) because marked HTML-escapes escape token text
				const escapedChar = escapeToken.raw.length > 1 ? escapeToken.raw.slice(1) : escapeToken.text
				return [{ type: "text", text: escapedChar || "", ...(hasStyle(style) && { style }) }]
			}
			case "html": {
				const htmlToken = token as marked.Tokens.HTML
				const trimmedHtml = htmlToken.text.trim().toLowerCase()
				if (trimmedHtml === "<br>" || trimmedHtml === "<br/>" || trimmedHtml === "<br />") {
					return [{ type: "text", text: "\n", ...(hasStyle(style) && { style }) }]
				}
				// Check for Slack special patterns in HTML tokens
				const slackElements = parseRawSlackSpecial(htmlToken.raw, style)
				if (slackElements) return slackElements
				return []
			}
			case "image":
				return [{ type: "text", text: token.text || token.title || "[image]" }]
			default:
				if ("text" in token && typeof (token as { text?: string }).text === "string") {
					return [{ type: "text", text: (token as { text: string }).text, ...(hasStyle(style) && { style }) }]
				}
				return []
		}
	}

	// Recursive cases: tokens with children
	const childTokens = (token as { tokens: PhrasingToken[] }).tokens
	switch (token.type) {
		case "text":
			return processTokensWithStyle(childTokens, style)
		case "strong":
			return processTokensWithStyle(childTokens, { ...style, bold: true })
		case "em":
			return processTokensWithStyle(childTokens, { ...style, italic: true })
		case "del":
			return processTokensWithStyle(childTokens, { ...style, strike: true })
		case "link":
			return createLinkElements(token as marked.Tokens.Link, childTokens, style)
		default:
			return processTokensWithStyle(childTokens, style)
	}
}

function processTokensWithStyle(tokens: PhrasingToken[], style?: RichTextStyle): RichTextSectionElement[] {
	const elements: RichTextSectionElement[] = []
	for (const token of tokens) {
		elements.push(...tokenToRichTextElements(token, style))
	}
	return elements
}

/**
 * Converts inline marked tokens to RichTextSectionElements for use in
 * rich_text_list items, table cells, and blockquotes.
 */
function tokensToRichTextElements(tokens: PhrasingToken[]): RichTextSectionElement[] {
	return processTokensWithStyle(tokens)
}

/**
 * Parses raw HTML tokens that may be Slack special patterns.
 * marked parses patterns like <!here>, <!channel>, <!everyone> as HTML
 * declarations, so they appear as html tokens rather than text tokens.
 */
function parseRawSlackSpecial(raw: string, style?: RichTextStyle): RichTextSectionElement[] | null {
	const trimmed = raw.trim()
	const match = trimmed.match(/^<(!(?:here|channel|everyone)|!subteam\^[A-Z0-9]+|@[A-Z0-9]+|#[A-Z0-9]+)>$/)
	if (!match) return null

	const content = match[1]
	if (content === "!here") return [{ type: "broadcast", range: "here", ...(hasStyle(style) && { style }) }]
	if (content === "!channel") return [{ type: "broadcast", range: "channel", ...(hasStyle(style) && { style }) }]
	if (content === "!everyone") return [{ type: "broadcast", range: "everyone", ...(hasStyle(style) && { style }) }]
	if (content.startsWith("!subteam^")) {
		return [{ type: "usergroup", usergroup_id: content.slice(9), ...(hasStyle(style) && { style }) }]
	}
	if (content.startsWith("@")) {
		return [{ type: "user", user_id: content.slice(1), ...(hasStyle(style) && { style }) }]
	}
	if (content.startsWith("#")) {
		return [{ type: "channel", channel_id: content.slice(1), ...(hasStyle(style) && { style }) }]
	}
	return null
}

/** Inline token types that can appear in simple list items */
const INLINE_TOKEN_TYPES = new Set(["paragraph", "text", "html"])

/** Block-level token types that make a list item complex */
const BLOCK_TOKEN_TYPES = new Set(["code", "list", "blockquote", "table"])

/**
 * Checks if a list item is "simple" (only inline content, no block-level elements).
 * Simple items can be grouped together in a single rich_text_list block.
 */
function isSimpleListItem(tokens: marked.Token[]): boolean {
	return tokens.length > 0 && tokens.every((t) => !BLOCK_TOKEN_TYPES.has(t.type))
}

/**
 * Gets the inline rich text elements from all inline tokens in a list item.
 * When multiple paragraphs are present, inserts \n separators between them.
 */
function getInlineElements(tokens: marked.Token[]): RichTextSectionElement[] {
	const elements: RichTextSectionElement[] = []
	let blockCount = 0
	for (const token of tokens) {
		if (token.type === "space") continue
		if (token.type === "paragraph") {
			if (blockCount > 0) {
				elements.push({ type: "text", text: "\n" })
			}
			const para = token as marked.Tokens.Paragraph
			elements.push(...tokensToRichTextElements(para.tokens as PhrasingToken[]))
			blockCount++
		} else if (token.type === "text") {
			if (blockCount > 0) {
				elements.push({ type: "text", text: "\n" })
			}
			const textToken = token as marked.Tokens.Text
			if (textToken.tokens?.length) {
				elements.push(...tokensToRichTextElements(textToken.tokens as PhrasingToken[]))
			} else {
				elements.push({ type: "text", text: textToken.text })
			}
			blockCount++
		} else if (token.type === "html") {
			const htmlToken = token as marked.Tokens.HTML
			const slackElements = parseRawSlackSpecial(htmlToken.raw)
			if (slackElements) {
				elements.push(...slackElements)
			}
		}
	}
	return elements
}

function parseList(element: marked.Tokens.List, options: ListOptions = {}, indent = 0): (KnownBlock | RichTextBlock)[] {
	const blocks: (KnownBlock | RichTextBlock)[] = []
	const listStyle = element.ordered ? "ordered" : "bullet"

	const defaultCheckboxPrefix = (checked: boolean): string => {
		return checked ? "\u2611 " : "\u2610 "
	}
	const checkboxPrefix = options.checkboxPrefix || defaultCheckboxPrefix

	// Track items for grouping and offset calculation
	let currentSimpleItems: RichTextElement[] = []
	let lastItemNumber = 0
	const startOffset = typeof element.start === "number" ? element.start - 1 : 0

	const computeOffset = () => {
		if (!element.ordered) return undefined
		if (startOffset > 0 && lastItemNumber === 0) return startOffset
		if (lastItemNumber > 0) return lastItemNumber
		return undefined
	}

	const flushSimpleItems = () => {
		if (currentSimpleItems.length === 0) return
		blocks.push(richTextList(currentSimpleItems, listStyle, indent, computeOffset()))
		lastItemNumber += currentSimpleItems.length
		currentSimpleItems = []
	}

	for (const item of element.items) {
		const isTaskItem = "checked" in item && typeof item.checked === "boolean"
		const checkboxText = isTaskItem && item.checked !== undefined ? checkboxPrefix(item.checked) : ""

		// Filter out checkbox tokens
		const contentTokens = item.tokens.filter((t) => (t as { type: string }).type !== "checkbox")

		if (isSimpleListItem(contentTokens)) {
			let elements = getInlineElements(contentTokens)
			if (checkboxText && elements.length > 0) {
				if (elements[0].type === "text") {
					elements = [{ ...elements[0], text: checkboxText + elements[0].text }, ...elements.slice(1)]
				} else {
					elements = [{ type: "text", text: checkboxText }, ...elements]
				}
			}
			if (elements.length > 0) {
				currentSimpleItems.push({ type: "rich_text_section", elements })
			}
			continue
		}

		// Complex item - flush accumulated simple items first
		flushSimpleItems()

		if (contentTokens.length === 0) continue

		// Separate inline tokens (first group) from block tokens
		const inlineTokens: marked.Token[] = []
		let blockStartIndex = contentTokens.length
		for (let i = 0; i < contentTokens.length; i++) {
			if (BLOCK_TOKEN_TYPES.has(contentTokens[i].type)) {
				blockStartIndex = i
				break
			}
			inlineTokens.push(contentTokens[i])
		}

		// First inline tokens become the list item text
		let firstItemElements = getInlineElements(inlineTokens)
		if (checkboxText && firstItemElements.length > 0) {
			if (firstItemElements[0].type === "text") {
				firstItemElements = [{ ...firstItemElements[0], text: checkboxText + firstItemElements[0].text }, ...firstItemElements.slice(1)]
			} else {
				firstItemElements = [{ type: "text", text: checkboxText }, ...firstItemElements]
			}
		}

		if (firstItemElements.length > 0) {
			blocks.push(richTextList([{ type: "rich_text_section", elements: firstItemElements }], listStyle, indent, computeOffset()))
			lastItemNumber++
		}

		// Process remaining block-level tokens
		type RichTextBlockElement = RichTextBlock["elements"][number]
		const remainingElements: RichTextBlockElement[] = []

		for (let i = blockStartIndex; i < contentTokens.length; i++) {
			const token = contentTokens[i]
			if (token.type === "paragraph" || token.type === "text" || token.type === "html") {
				const elements = getInlineElements([token])
				if (elements.length > 0) {
					remainingElements.push({ type: "rich_text_section", elements })
				}
			} else if (token.type === "code") {
				const code = token as marked.Tokens.Code
				remainingElements.push({
					type: "rich_text_preformatted",
					elements: [{ type: "text", text: code.text }]
				})
			} else if (token.type === "blockquote") {
				const bqToken = token as marked.Tokens.Blockquote
				const bqBlocks = parseBlockquote(bqToken)
				for (const block of bqBlocks) {
					if (block.type === "rich_text") {
						remainingElements.push(...(block as RichTextBlock).elements)
					} else {
						if (remainingElements.length > 0) {
							blocks.push({ type: "rich_text", elements: [...remainingElements] } as RichTextBlock)
							remainingElements.length = 0
						}
						blocks.push(block as KnownBlock)
					}
				}
			} else if (token.type === "list") {
				// Nested list with increased indent
				const nestedBlocks = parseList(token as marked.Tokens.List, options, indent + 1)
				for (const block of nestedBlocks) {
					if (block.type === "rich_text") {
						remainingElements.push(...(block as RichTextBlock).elements)
					} else {
						if (remainingElements.length > 0) {
							blocks.push({ type: "rich_text", elements: [...remainingElements] } as RichTextBlock)
							remainingElements.length = 0
						}
						blocks.push(block)
					}
				}
			}
		}

		if (remainingElements.length > 0) {
			blocks.push({ type: "rich_text", elements: remainingElements } as RichTextBlock)
		}
	}

	// Flush remaining simple items
	flushSimpleItems()

	return blocks
}

function parseTableCellToBlock(cell: marked.Tokens.TableCell): TableCell {
	const hasComplexFormatting = cell.tokens.some((token) => {
		const tokenType = (token as PhrasingToken).type
		return ["strong", "em", "del", "link", "codespan"].includes(tokenType)
	})

	if (hasComplexFormatting) {
		const elements = tokensToRichTextElements(cell.tokens as PhrasingToken[])
		return {
			type: "rich_text",
			elements: [{ type: "rich_text_section", elements }]
		}
	} else {
		const text = cell.tokens
			.map((token) => {
				if ("text" in token) {
					return (token as marked.Tokens.Text).text
				}
				return ""
			})
			.join("")
		return { type: "raw_text", text }
	}
}

function parseTableRowsToBlocks(
	headerCells: marked.Tokens.TableCell[],
	rows: marked.Tokens.TableCell[][],
	align: Array<"left" | "center" | "right" | null>
): { tableRows: TableRow[]; columnSettings: ColumnSetting[] } {
	const tableRows: TableRow[] = []

	const headerRow: TableCell[] = headerCells.map((cell) => parseTableCellToBlock(cell))
	tableRows.push(headerRow)

	for (const row of rows) {
		const tableRow: TableCell[] = row.map((cell) => parseTableCellToBlock(cell))
		tableRows.push(tableRow)
	}

	const columnSettings: ColumnSetting[] = []
	for (let i = 0; i < align.length && i < 20; i++) {
		if (align[i] && align[i] !== "left") {
			columnSettings.push({ align: align[i] as "center" | "right" })
		} else if (columnSettings.length > 0) {
			columnSettings.push({})
		}
	}

	return { tableRows, columnSettings }
}

function parseTable(element: marked.Tokens.Table): TableBlock {
	const { tableRows, columnSettings } = parseTableRowsToBlocks(element.header, element.rows, element.align)

	return table(tableRows, columnSettings.length > 0 ? columnSettings : undefined)
}

function prefixWithBlockquoteMarker(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n")
}

function parseBlockquote(element: marked.Tokens.Blockquote): (KnownBlock | TableBlock | RichTextBlock | VideoBlock)[] {
	const onlyParagraphs = element.tokens.every((token) => token.type === "paragraph" || token.type === "text" || token.type === "space")

	if (onlyParagraphs) {
		const quoteElements: RichTextSectionElement[] = []

		for (const token of element.tokens) {
			if (token.type === "paragraph") {
				const paragraphToken = token as marked.Tokens.Paragraph
				if (paragraphToken.tokens?.length) {
					const richElements = tokensToRichTextElements(paragraphToken.tokens as PhrasingToken[])
					quoteElements.push(...richElements)
					if (element.tokens.indexOf(token) < element.tokens.length - 1) {
						quoteElements.push({ type: "text", text: "\n" })
					}
				}
			} else if (token.type === "text") {
				const textToken = token as marked.Tokens.Text
				if (textToken.tokens?.length) {
					const richElements = tokensToRichTextElements(textToken.tokens as PhrasingToken[])
					quoteElements.push(...richElements)
				} else {
					quoteElements.push({ type: "text", text: textToken.text })
				}
			}
		}

		if (quoteElements.length > 0) {
			return [richTextQuote(quoteElements)]
		}
		return []
	}

	// Complex blockquotes: fall back to section blocks with > prefix
	const blocks = element.tokens.flatMap((token) => {
		if (token.type === "space") return []
		if (token.type === "paragraph") {
			return parseParagraph(token)
		} else if (token.type === "list") {
			return parseList(token)
		} else if (token.type === "code") {
			return [parseCode(token)]
		} else if (token.type === "blockquote") {
			return parseBlockquote(token)
		} else if (token.type === "heading") {
			return [parseHeading(token)]
		} else if (token.type === "html") {
			return parseHTML(token)
		}
		return []
	})

	return blocks.map((block) => {
		if ("type" in block && block.type === "section" && (block as SectionBlock).text?.text) {
			;(block as SectionBlock).text!.text = prefixWithBlockquoteMarker((block as SectionBlock).text!.text)
		} else if ("type" in block && block.type === "rich_text") {
			// Convert rich_text blocks to section blocks with > prefix
			const richBlock = block as RichTextBlock
			const plainText = richBlock.elements
				.map((el) => {
					if (el.type === "rich_text_section") {
						return el.elements.map((e) => (e.type === "text" ? e.text : "")).join("")
					}
					return ""
				})
				.join("\n")
			if (plainText.trim()) {
				return section(prefixWithBlockquoteMarker(plainText))
			}
		}
		return block
	})
}

function parseThematicBreak(): DividerBlock {
	return divider()
}

/**
 * Normalizes HTML for XML parsing by closing self-closing tags.
 * Converts `<img src="...">` to `<img src="..." />` for the XML parser.
 */
function normalizeHtmlForParsing(html: string): string {
	const selfClosingTags = ["img", "br", "hr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]
	return html.replace(/<(\w+)([^>]*?)(?:\s*\/)?>/gi, (match, tagName, attributes) => {
		if (selfClosingTags.includes(tagName.toLowerCase()) && !match.endsWith("/>")) {
			return `<${tagName}${attributes} />`
		}
		return match
	})
}

function parseHTML(element: marked.Tokens.HTML | marked.Tokens.Tag): (KnownBlock | RichTextBlock | TableBlock | VideoBlock)[] {
	const htmlText = element.raw.trim()
	if (!htmlText) return []

	// Check if this is a Slack special formatting pattern that marked parsed as HTML
	const slackElements = parseRawSlackSpecial(htmlText)
	if (slackElements) {
		return [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: slackElements }] } as RichTextBlock]
	}

	try {
		const normalizedHtml = normalizeHtmlForParsing(htmlText)
		const parser = new XMLParser(SECURE_XML_CONFIG)
		const res = parser.parse(normalizedHtml)
		const blocks: (KnownBlock | TableBlock | VideoBlock)[] = []

		if (res.img) {
			const tags = res.img instanceof Array ? res.img : [res.img]
			const imageBlocks = tags
				.map((img: Record<string, string>) => {
					const url: string = img["@_src"] || img["@_href"]
					if (!validateUrl(url)) {
						return null
					}
					return image(url, img["@_alt"] || img["@_title"] || url)
				})
				.filter((e: ImageBlock | null) => e !== null) as ImageBlock[]
			blocks.push(...imageBlocks)
		}

		if (res.video) {
			const tags = res.video instanceof Array ? res.video : [res.video]
			const videoBlocks = tags
				.map((vid: Record<string, unknown>) => {
					const videoUrl = String(vid["@_src"] || vid["@_href"] || "")
					const posterUrl = String(vid["@_poster"] || vid["@_thumbnail"] || "")
					const title = String(vid["@_title"] || vid["@_alt"] || vid["@_aria-label"] || "Video")
					const altText = String(vid["@_alt"] || vid["@_title"] || vid["@_aria-label"] || title)

					if (!videoUrl || !validateUrl(videoUrl)) {
						return null
					}

					try {
						return video({
							videoUrl,
							thumbnailUrl: posterUrl || videoUrl,
							title,
							altText,
							...(vid["@_data-title-url"] && { titleUrl: String(vid["@_data-title-url"]) }),
							...(vid["@_data-provider-name"] && { providerName: String(vid["@_data-provider-name"]) }),
							...(vid["@_data-provider-icon-url"] && { providerIconUrl: String(vid["@_data-provider-icon-url"]) }),
							...(vid["@_data-description"] && { description: String(vid["@_data-description"]) }),
							...(vid["@_data-author-name"] && { authorName: String(vid["@_data-author-name"]) })
						})
					} catch {
						return null
					}
				})
				.filter((e: VideoBlock | null) => e !== null) as VideoBlock[]
			blocks.push(...videoBlocks)
		}

		return blocks
	} catch {
		return []
	}
}

function parseToken(token: marked.Token, options: ParsingOptions): (KnownBlock | TableBlock | RichTextBlock | VideoBlock)[] {
	switch (token.type) {
		case "heading":
			return [parseHeading(token)]

		case "paragraph":
			return parseParagraph(token)

		case "code":
			return [parseCode(token)]

		case "blockquote":
			return parseBlockquote(token)

		case "list":
			return parseList(token, options.lists)

		case "table":
			return [parseTable(token)]

		case "hr":
			return [parseThematicBreak()]

		case "html":
			return parseHTML(token)

		default:
			return []
	}
}

export function parseBlocks(tokens: marked.TokensList, options: ParsingOptions = {}): (KnownBlock | TableBlock | RichTextBlock | VideoBlock)[] {
	return tokens.flatMap((token) => parseToken(token, options))
}
