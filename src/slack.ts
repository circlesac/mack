import type { DividerBlock, HeaderBlock, ImageBlock, SectionBlock } from "@slack/types"
import { escapeForSlackCode } from "./escape"
import { safeTruncate } from "./validation"

// Table block types (not yet in @slack/types)
export interface TableBlock {
	type: "table"
	block_id?: string
	rows: TableRow[]
	column_settings?: ColumnSetting[]
}

export type TableRow = TableCell[]

export interface TableCell {
	type: "raw_text" | "rich_text"
	text?: string // for raw_text
	elements?: RichTextElement[] // for rich_text
}

export interface ColumnSetting {
	align?: "left" | "center" | "right"
	is_wrapped?: boolean
}

export interface RichTextElement {
	type: "rich_text_section"
	elements: RichTextSectionElement[]
}

export type RichTextSectionElement =
	| RichTextTextElement
	| RichTextLinkElement
	| RichTextEmojiElement
	| RichTextUserElement
	| RichTextChannelElement
	| RichTextBroadcastElement
	| RichTextUsergroupElement
	| RichTextDateElement

export interface RichTextStyle {
	bold?: boolean
	italic?: boolean
	strike?: boolean
	code?: boolean
}

export interface RichTextTextElement {
	type: "text"
	text: string
	style?: RichTextStyle
}

export interface RichTextLinkElement {
	type: "link"
	url: string
	text?: string
	style?: RichTextStyle
}

export interface RichTextEmojiElement {
	type: "emoji"
	name: string
	style?: RichTextStyle
}

export interface RichTextUserElement {
	type: "user"
	user_id: string
	style?: RichTextStyle
}

export interface RichTextChannelElement {
	type: "channel"
	channel_id: string
	style?: RichTextStyle
}

export interface RichTextBroadcastElement {
	type: "broadcast"
	range: "here" | "channel" | "everyone"
	style?: RichTextStyle
}

export interface RichTextUsergroupElement {
	type: "usergroup"
	usergroup_id: string
	style?: RichTextStyle
}

export interface RichTextDateElement {
	type: "date"
	timestamp: number
	format: string
	fallback?: string
	style?: RichTextStyle
}

// Video block type (not yet in @slack/types)
export interface VideoBlock {
	type: "video"
	alt_text: string
	title: {
		type: "plain_text"
		text: string
		emoji?: boolean
	}
	thumbnail_url: string
	video_url: string
	author_name?: string
	description?: {
		type: "plain_text"
		text: string
		emoji?: boolean
	}
	provider_icon_url?: string
	provider_name?: string
	title_url?: string
}

export interface RichTextBlock {
	type: "rich_text"
	block_id?: string
	elements: (RichTextListElement | RichTextElement | RichTextPreformattedElement | RichTextQuoteElement)[]
}

export interface RichTextListElement {
	type: "rich_text_list"
	style: "bullet" | "ordered"
	indent?: number
	offset?: number
	border?: number
	elements: RichTextElement[]
}

export interface RichTextPreformattedElement {
	type: "rich_text_preformatted"
	elements: RichTextSectionElement[]
	border?: number
}

export interface RichTextQuoteElement {
	type: "rich_text_quote"
	elements: RichTextSectionElement[]
	border?: number
}

const MAX_TEXT_LENGTH = 3000
const MAX_HEADER_LENGTH = 150
const MAX_IMAGE_TITLE_LENGTH = 2000
const MAX_IMAGE_ALT_TEXT_LENGTH = 2000
const MAX_TABLE_ROWS = 100
const MAX_TABLE_CELLS_PER_ROW = 20
const MAX_VIDEO_TITLE_LENGTH = 200
const MAX_VIDEO_ALT_TEXT_LENGTH = 2000

export function section(text: string): SectionBlock {
	return {
		type: "section",
		text: {
			type: "mrkdwn",
			text: safeTruncate(text, MAX_TEXT_LENGTH)
		}
	}
}

export function divider(): DividerBlock {
	return {
		type: "divider"
	}
}

export function header(text: string): HeaderBlock {
	return {
		type: "header",
		text: {
			type: "plain_text",
			text: safeTruncate(text, MAX_HEADER_LENGTH)
		}
	}
}

export function image(url: string, altText: string, title?: string): ImageBlock {
	return {
		type: "image",
		image_url: url,
		alt_text: safeTruncate(altText, MAX_IMAGE_ALT_TEXT_LENGTH),
		title: title
			? {
					type: "plain_text",
					text: safeTruncate(title, MAX_IMAGE_TITLE_LENGTH)
				}
			: undefined
	}
}

export function richTextList(items: RichTextElement[], style: "bullet" | "ordered" = "bullet", indent = 0, offset?: number): RichTextBlock {
	return {
		type: "rich_text",
		elements: [
			{
				type: "rich_text_list",
				style,
				indent,
				...(offset !== undefined && { offset }),
				elements: items
			}
		]
	}
}

export function richTextCode(code: string): RichTextBlock {
	return {
		type: "rich_text",
		elements: [
			{
				type: "rich_text_preformatted",
				elements: [
					{
						type: "text",
						text: escapeForSlackCode(code)
					}
				]
			}
		]
	}
}

export function richTextQuote(elements: RichTextSectionElement[]): RichTextBlock {
	return {
		type: "rich_text",
		elements: [
			{
				type: "rich_text_quote",
				elements
			}
		]
	}
}

export interface VideoBlockOptions {
	altText: string
	title: string
	thumbnailUrl: string
	videoUrl: string
	authorName?: string
	description?: string
	providerIconUrl?: string
	providerName?: string
	titleUrl?: string
}

export function video(options: VideoBlockOptions): VideoBlock {
	return {
		type: "video",
		alt_text: safeTruncate(options.altText, MAX_VIDEO_ALT_TEXT_LENGTH),
		title: {
			type: "plain_text",
			text: safeTruncate(options.title, MAX_VIDEO_TITLE_LENGTH),
			emoji: true
		},
		thumbnail_url: options.thumbnailUrl,
		video_url: options.videoUrl,
		author_name: options.authorName,
		description: options.description
			? {
					type: "plain_text",
					text: safeTruncate(options.description, MAX_VIDEO_TITLE_LENGTH),
					emoji: true
				}
			: undefined,
		provider_icon_url: options.providerIconUrl,
		provider_name: options.providerName,
		title_url: options.titleUrl
	}
}

export function table(rows: TableRow[], columnSettings?: ColumnSetting[]): TableBlock {
	// Enforce Slack limits
	const limitedRows = rows.slice(0, MAX_TABLE_ROWS)
	for (let i = 0; i < limitedRows.length; i++) {
		limitedRows[i] = limitedRows[i].slice(0, MAX_TABLE_CELLS_PER_ROW)
	}

	return {
		type: "table",
		rows: limitedRows,
		column_settings: columnSettings
	}
}
