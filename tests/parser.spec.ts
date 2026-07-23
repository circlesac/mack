import { marked } from "marked"
import { parseBlocks } from "../src/parser/internal"
import * as slack from "../src/slack"

describe("parser", () => {
	it("should parse basic markdown", () => {
		const tokens = marked.lexer("**a ~b~** c[*d*](https://example.com)")
		const actual = parseBlocks(tokens)

		// Paragraphs render as rich_text: styles are structural, so emphasis
		// works even when a marker touches a word character (CJK particles).
		const expected = [
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: [
							{ type: "text", text: "a ", style: { bold: true } },
							{ type: "text", text: "b", style: { bold: true, strike: true } },
							{ type: "text", text: " c" },
							{ type: "link", url: "https://example.com", text: "d", style: { italic: true } }
						]
					}
				]
			}
		]

		expect(actual).toStrictEqual(expected)
	})

	it("should parse header", () => {
		const tokens = marked.lexer("# a")
		const actual = parseBlocks(tokens)

		const expected = [slack.header("a")]

		expect(actual).toStrictEqual(expected)
	})

	it("should parse thematic break", () => {
		const tokens = marked.lexer("---")
		const actual = parseBlocks(tokens)

		const expected = [slack.divider()]

		expect(actual).toStrictEqual(expected)
	})

	it("should parse lists as rich_text_list blocks", () => {
		const tokens = marked.lexer(
			`
    1. a
    2. b
    - c
    - d
    * e
    * f
    `
				.trim()
				.split("\n")
				.map((s) => s.trim())
				.join("\n")
		)
		const actual = parseBlocks(tokens)

		expect(actual).toHaveLength(3)

		// Ordered list
		expect(actual[0]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "ordered",
					elements: [
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "a" }]
						},
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "b" }]
						}
					]
				}
			]
		})

		// Bullet lists
		expect(actual[1]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "bullet",
					elements: [
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "c" }]
						},
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "d" }]
						}
					]
				}
			]
		})

		expect(actual[2]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "bullet"
				}
			]
		})
	})

	it("should parse images", () => {
		const tokens = marked.lexer('![alt](url "title")![](url)')
		const actual = parseBlocks(tokens)

		const expected = [slack.image("url", "alt", "title"), slack.image("url", "url")]

		expect(actual).toStrictEqual(expected)
	})

	it("should parse code blocks as rich_text_preformatted", () => {
		const tokens = marked.lexer("```\nconst x = 1;\n```")
		const actual = parseBlocks(tokens)

		expect(actual).toStrictEqual([slack.richTextCode("const x = 1;")])
	})

	it("should parse tables as native table blocks", () => {
		const tokens = marked.lexer("| A | B |\n| --- | --- |\n| 1 | 2 |")
		const actual = parseBlocks(tokens)

		expect(actual).toHaveLength(1)
		expect(actual[0]).toMatchObject({ type: "table" })
		const tableBlock = actual[0] as slack.TableBlock
		expect(tableBlock.rows).toHaveLength(2) // header + 1 data row
		expect(tableBlock.rows[0][0]).toMatchObject({ type: "raw_text", text: "A" })
		expect(tableBlock.rows[1][0]).toMatchObject({ type: "raw_text", text: "1" })
	})

	it("should emit a space for empty table cells (Slack rejects empty raw_text)", () => {
		const tokens = marked.lexer("| A | B |\n| --- | --- |\n| 1 |  |\n|  | 2 |")
		const actual = parseBlocks(tokens)
		const tableBlock = actual[0] as slack.TableBlock
		// every raw_text cell must be non-empty or Slack invalidates the whole table
		for (const row of tableBlock.rows) {
			for (const cell of row) {
				if (cell.type === "raw_text") expect((cell.text ?? "").length).toBeGreaterThan(0)
			}
		}
		expect(tableBlock.rows[1][1]).toMatchObject({ type: "raw_text", text: " " })
		expect(tableBlock.rows[2][0]).toMatchObject({ type: "raw_text", text: " " })
	})

	it("should parse blockquotes as rich_text_quote", () => {
		const tokens = marked.lexer("> hello world")
		const actual = parseBlocks(tokens)

		expect(actual).toStrictEqual([slack.richTextQuote([{ type: "text", text: "hello world" }])])
	})

	it("should parse emoji shortcodes in blockquotes as emoji elements", () => {
		const tokens = marked.lexer("> :bulb: tip")
		const actual = parseBlocks(tokens)

		expect(actual).toStrictEqual([
			slack.richTextQuote([
				{ type: "emoji", name: "bulb" },
				{ type: "text", text: " tip" }
			])
		])
	})

	it("should parse emoji shortcodes in table cells as rich_text", () => {
		const tokens = marked.lexer("| A | B |\n| --- | --- |\n| :rocket: | 2 |")
		const actual = parseBlocks(tokens)

		expect(actual).toHaveLength(1)
		const tableBlock = actual[0] as slack.TableBlock
		expect(tableBlock.rows[0][0]).toMatchObject({ type: "raw_text", text: "A" })
		expect(tableBlock.rows[1][0]).toMatchObject({
			type: "rich_text",
			elements: [{ type: "rich_text_section", elements: [{ type: "emoji", name: "rocket" }] }]
		})
		expect(tableBlock.rows[1][1]).toMatchObject({ type: "raw_text", text: "2" })
	})

	it("should parse emoji shortcodes in paragraphs as emoji elements", () => {
		const tokens = marked.lexer(":rocket: launch :bulb:")
		const actual = parseBlocks(tokens)

		expect(actual).toHaveLength(1)
		expect(actual[0]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_section",
					elements: [
						{ type: "emoji", name: "rocket" },
						{ type: "text", text: " launch " },
						{ type: "emoji", name: "bulb" }
					]
				}
			]
		})
	})
})

it("should truncate basic markdown", () => {
	const a4000 = new Array(4000).fill("a").join("")
	const a3000 = new Array(3000).fill("a").join("")

	const tokens = marked.lexer(a4000)
	const actual = parseBlocks(tokens)

	const expected = [slack.section(a3000)]

	expect(actual.length).toStrictEqual(expected.length)
})

it("should truncate header", () => {
	const a200 = new Array(200).fill("a").join("")
	const a150 = new Array(150).fill("a").join("")

	const tokens = marked.lexer(`# ${a200}`)
	const actual = parseBlocks(tokens)

	const expected = [slack.header(a150)]

	expect(actual.length).toStrictEqual(expected.length)
})

it("should truncate image title", () => {
	const a3000 = new Array(3000).fill("a").join("")
	const a2000 = new Array(2000).fill("a").join("")

	const tokens = marked.lexer(`![${a3000}](url)`)
	const actual = parseBlocks(tokens)

	const expected = [slack.image("url", a2000)]

	expect(actual.length).toStrictEqual(expected.length)
})
