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

let recursionDepth = 0

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
				return `\`${element.text}\``

			case "strong": {
				return `*${element.tokens.flatMap((child) => parseMrkdwn(child as Exclude<PhrasingToken, marked.Tokens.Image>)).join("")}*`
			}

			case "text":
				return element.text

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

/**
 * Parses Slack special formatting patterns in text and returns rich text elements.
 * Handles: <@USER_ID>, <#CHANNEL_ID>, <!here>, <!channel>, <!everyone>,
 * <!subteam^TEAM_ID>, <!date^timestamp^format|fallback>, <url|text>
 *
 * Note: The tokenizer escapes < > & to &lt; &gt; &amp;, so we match escaped forms.
 */
function parseSlackSpecialFormatting(text: string): RichTextSectionElement[] {
	// Match escaped angle brackets: &lt;...&gt;
	const slackPattern = /&lt;(@[A-Z0-9]+(?:\|[^&]+)?|#[A-Z0-9]+(?:\|[^&]+)?|![a-z]+(?:\^[^&]+)*(?:\|[^&]+)?|https?:\/\/[^|&]+\|[^&]+|https?:\/\/[^&]+)&gt;/g

	const elements: RichTextSectionElement[] = []
	let lastIndex = 0
	let match: RegExpExecArray | null

	while ((match = slackPattern.exec(text)) !== null) {
		if (match.index > lastIndex) {
			elements.push({ type: "text", text: text.slice(lastIndex, match.index) })
		}

		const content = match[1]

		if (content.startsWith("@")) {
			const [userId] = content.slice(1).split("|")
			elements.push({ type: "user", user_id: userId })
		} else if (content.startsWith("#")) {
			const [channelId] = content.slice(1).split("|")
			elements.push({ type: "channel", channel_id: channelId })
		} else if (content.startsWith("!")) {
			if (content === "!here") {
				elements.push({ type: "broadcast", range: "here" })
			} else if (content === "!channel") {
				elements.push({ type: "broadcast", range: "channel" })
			} else if (content === "!everyone") {
				elements.push({ type: "broadcast", range: "everyone" })
			} else if (content.startsWith("!subteam^")) {
				const usergroupId = content.slice(9)
				elements.push({ type: "usergroup", usergroup_id: usergroupId })
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
					...(fallback && { fallback })
				})
			} else {
				elements.push({ type: "text", text: match[0] })
			}
		} else if (content.startsWith("http://") || content.startsWith("https://")) {
			const pipeIndex = content.indexOf("|")
			if (pipeIndex !== -1) {
				elements.push({
					type: "link",
					url: content.slice(0, pipeIndex),
					text: content.slice(pipeIndex + 1)
				})
			} else {
				elements.push({ type: "link", url: content })
			}
		} else {
			elements.push({ type: "text", text: match[0] })
		}

		lastIndex = match.index + match[0].length
	}

	if (lastIndex < text.length) {
		elements.push({ type: "text", text: text.slice(lastIndex) })
	}

	if (elements.length === 0) {
		return [{ type: "text", text }]
	}

	return elements
}

/**
 * Converts inline marked tokens to RichTextSectionElements for use in
 * rich_text_list items, table cells, and blockquotes.
 */
function tokensToRichTextElements(tokens: PhrasingToken[]): RichTextSectionElement[] {
	const elements: RichTextSectionElement[] = []

	for (const token of tokens) {
		switch (token.type) {
			case "text":
				elements.push(...parseSlackSpecialFormatting(token.text))
				break

			case "strong": {
				const strongText = token.tokens.map((t) => (t as marked.Tokens.Text).text || "").join("")
				elements.push({ type: "text", text: strongText, style: { bold: true } })
				break
			}

			case "em": {
				const emText = token.tokens.map((t) => (t as marked.Tokens.Text).text || "").join("")
				elements.push({ type: "text", text: emText, style: { italic: true } })
				break
			}

			case "del": {
				const delText = token.tokens.map((t) => (t as marked.Tokens.Text).text || "").join("")
				elements.push({ type: "text", text: delText, style: { strike: true } })
				break
			}

			case "codespan":
				elements.push({ type: "text", text: token.text, style: { code: true } })
				break

			case "link": {
				const linkText = token.tokens.map((t) => (t as marked.Tokens.Text).text || "").join("")
				if (validateUrl(token.href)) {
					elements.push({ type: "link", text: linkText, url: token.href })
				} else {
					elements.push({ type: "text", text: linkText })
				}
				break
			}

			case "image":
				elements.push({
					type: "text",
					text: token.text || token.title || "[image]"
				})
				break

			default:
				if ("text" in token && typeof (token as { text?: string }).text === "string") {
					elements.push({ type: "text", text: (token as { text: string }).text })
				}
		}
	}

	return elements
}

/**
 * Parses raw (unescaped) HTML tokens that may be Slack special patterns.
 * marked parses patterns like <!here>, <!channel>, <!everyone> as HTML
 * declarations, so they appear as html tokens rather than text tokens.
 */
function parseRawSlackSpecial(raw: string): RichTextSectionElement[] | null {
	const trimmed = raw.trim()
	const match = trimmed.match(/^<(!(?:here|channel|everyone)|!subteam\^[A-Z0-9]+|@[A-Z0-9]+|#[A-Z0-9]+)>$/)
	if (!match) return null

	const content = match[1]
	if (content === "!here") return [{ type: "broadcast", range: "here" }]
	if (content === "!channel") return [{ type: "broadcast", range: "channel" }]
	if (content === "!everyone") return [{ type: "broadcast", range: "everyone" }]
	if (content.startsWith("!subteam^")) {
		return [{ type: "usergroup", usergroup_id: content.slice(9) }]
	}
	if (content.startsWith("@")) {
		return [{ type: "user", user_id: content.slice(1) }]
	}
	if (content.startsWith("#")) {
		return [{ type: "channel", channel_id: content.slice(1) }]
	}
	return null
}

function parseList(element: marked.Tokens.List, options: ListOptions = {}, indent = 0): RichTextBlock {
	const items: RichTextElement[] = []

	const defaultCheckboxPrefix = (checked: boolean): string => {
		return checked ? "\u2611 " : "\u2610 "
	}

	const checkboxPrefix = options.checkboxPrefix || defaultCheckboxPrefix

	for (const item of element.items) {
		const itemElements: RichTextSectionElement[] = []

		if (item.task) {
			const prefix = checkboxPrefix(item.checked || false)
			itemElements.push({ type: "text", text: prefix })
		}

		for (const token of item.tokens) {
			if (token.type === "text" || token.type === "paragraph") {
				const textToken = token as marked.Tokens.Text | marked.Tokens.Paragraph
				if (!textToken.tokens?.length) {
					continue
				}
				const richElements = tokensToRichTextElements(textToken.tokens as PhrasingToken[])
				itemElements.push(...richElements)
			} else if (token.type === "code") {
				const codeToken = token as marked.Tokens.Code
				itemElements.push({
					type: "text",
					text: `\n${codeToken.text}\n`,
					style: { code: true }
				})
			} else if (token.type === "html") {
				const htmlToken = token as marked.Tokens.HTML
				const slackElements = parseRawSlackSpecial(htmlToken.raw)
				if (slackElements) {
					itemElements.push(...slackElements)
				}
			}
		}

		items.push({ type: "rich_text_section", elements: itemElements })
	}

	let style: "bullet" | "ordered" = "bullet"
	if (element.ordered) {
		style = "ordered"
	}

	return richTextList(items, style, indent)
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
		if (token.type === "paragraph") {
			return parseParagraph(token)
		} else if (token.type === "list") {
			return [parseList(token)]
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
			;(block as SectionBlock).text!.text = "> " + (block as SectionBlock).text!.text.replace(/\n/g, "\n> ")
		}
		return block
	})
}

function parseThematicBreak(): DividerBlock {
	return divider()
}

function parseHTML(element: marked.Tokens.HTML | marked.Tokens.Tag): (KnownBlock | TableBlock | VideoBlock)[] {
	try {
		const parser = new XMLParser(SECURE_XML_CONFIG)
		const res = parser.parse(element.raw)
		const blocks: (KnownBlock | TableBlock | VideoBlock)[] = []

		if (res.img) {
			const tags = res.img instanceof Array ? res.img : [res.img]
			const imageBlocks = tags
				.map((img: Record<string, string>) => {
					const url: string = img["@_src"]
					if (!validateUrl(url)) {
						return null
					}
					return image(url, img["@_alt"] || url)
				})
				.filter((e: ImageBlock | null) => e !== null) as ImageBlock[]
			blocks.push(...imageBlocks)
		}

		if (res.video) {
			const tags = res.video instanceof Array ? res.video : [res.video]
			const videoBlocks = tags
				.map((vid: Record<string, unknown>) => {
					const videoUrl = String(vid["@_src"] || "")
					const posterUrl = String(vid["@_poster"] || "")
					const title = String(vid["@_title"] || "Video")
					const altText = String(vid["@_alt"] || title)

					if (!videoUrl || !validateUrl(videoUrl)) {
						return null
					}

					try {
						return video({
							videoUrl,
							thumbnailUrl: posterUrl || videoUrl,
							title,
							altText
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
			return [parseList(token, options.lists)]

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
