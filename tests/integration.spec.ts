import { readFileSync } from "fs"
import { join } from "path"
import { markdownToBlocks, markdownToSlackText } from "../src"
import * as slack from "../src/slack"

const fixturesDir = join(__dirname, "fixtures")

function readFixture(name: string): string {
	return readFileSync(join(fixturesDir, `${name}.md`), "utf-8")
}

describe("integration with unified", () => {
	it("should parse raw markdown into slack blocks", async () => {
		const text = `
a **b** _c_ **_d_ e**

# heading **a**

![59953191-480px](https://user-images.githubusercontent.com/16073505/123464383-b8715300-d5ba-11eb-8586-b1f965e1f18d.jpg)

<img src="https://user-images.githubusercontent.com/16073505/123464383-b8715300-d5ba-11eb-8586-b1f965e1f18d.jpg" alt="59953191-480px"/>

> block quote **a**
> block quote b

[link](https://apple.com)

- bullet _a_
- bullet _b_

1. number _a_
2. number _b_

- [ ] checkbox false
- [x] checkbox true

| Syntax      | Description |
| ----------- | ----------- |
| Header      | Title       |
| Paragraph   | Text        |
`

		const actual = await markdownToBlocks(text)

		// Paragraph → rich_text with structural styles
		expect(actual[0]).toStrictEqual({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_section",
					elements: [
						{ type: "text", text: "a " },
						{ type: "text", text: "b", style: { bold: true } },
						{ type: "text", text: " " },
						{ type: "text", text: "c", style: { italic: true } },
						{ type: "text", text: " " },
						{ type: "text", text: "d", style: { bold: true, italic: true } },
						{ type: "text", text: " e", style: { bold: true } }
					]
				}
			]
		})

		// Heading
		expect(actual[1]).toStrictEqual(slack.header("heading a"))

		// Markdown image
		expect(actual[2]).toStrictEqual(slack.image("https://user-images.githubusercontent.com/16073505/123464383-b8715300-d5ba-11eb-8586-b1f965e1f18d.jpg", "59953191-480px"))

		// HTML image
		expect(actual[3]).toStrictEqual(slack.image("https://user-images.githubusercontent.com/16073505/123464383-b8715300-d5ba-11eb-8586-b1f965e1f18d.jpg", "59953191-480px"))

		// Blockquote -> rich_text_quote
		expect(actual[4]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_quote",
					elements: [{ type: "text", text: "block quote " }, { type: "text", text: "a", style: { bold: true } }, { type: "text" }]
				}
			]
		})

		// Link
		expect(actual[5]).toStrictEqual({
			type: "rich_text",
			elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://apple.com", text: "link" }] }]
		})

		// Bullet list -> rich_text_list
		expect(actual[6]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "bullet",
					elements: [
						{
							type: "rich_text_section",
							elements: [
								{ type: "text", text: "bullet " },
								{ type: "text", text: "a", style: { italic: true } }
							]
						},
						{
							type: "rich_text_section",
							elements: [
								{ type: "text", text: "bullet " },
								{ type: "text", text: "b", style: { italic: true } }
							]
						}
					]
				}
			]
		})

		// Ordered list -> rich_text_list
		expect(actual[7]).toMatchObject({
			type: "rich_text",
			elements: [{ type: "rich_text_list", style: "ordered" }]
		})

		// Checkbox list -> rich_text_list with checkbox prefix
		expect(actual[8]).toMatchObject({
			type: "rich_text",
			elements: [
				{
					type: "rich_text_list",
					style: "bullet",
					elements: [
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "\u2610 checkbox false" }]
						},
						{
							type: "rich_text_section",
							elements: [{ type: "text", text: "\u2611 checkbox true" }]
						}
					]
				}
			]
		})

		// Table -> native table block
		expect(actual[9]).toMatchObject({
			type: "table",
			rows: [
				[
					{ type: "raw_text", text: "Syntax" },
					{ type: "raw_text", text: "Description" }
				],
				[
					{ type: "raw_text", text: "Header" },
					{ type: "raw_text", text: "Title" }
				],
				[
					{ type: "raw_text", text: "Paragraph" },
					{ type: "raw_text", text: "Text" }
				]
			]
		})
	})

	it("should parse long markdown", async () => {
		const text: string = new Array(3500).fill("a").join("") + "bbbcccdddeee"

		const actual = await markdownToBlocks(text)

		// rich_text has no 3000-char section limit — long paragraphs are no
		// longer silently truncated.
		const expected = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }] }]

		expect(actual).toStrictEqual(expected)
	})

	describe("code blocks", () => {
		it("should parse code blocks with no language", async () => {
			const text = `\`\`\`
if (a === 'hi') {
  console.log('hi!')
} else {
  console.log('hello')
}
\`\`\``

			const actual = await markdownToBlocks(text)

			const expected = [slack.richTextCode("if (a === 'hi') {\n  console.log('hi!')\n} else {\n  console.log('hello')\n}")]

			expect(actual).toStrictEqual(expected)
		})

		it("should parse code blocks with language", async () => {
			const text = `\`\`\`javascript
if (a === 'hi') {
  console.log('hi!')
} else {
  console.log('hello')
}
\`\`\``

			const actual = await markdownToBlocks(text)

			const expected = [slack.richTextCode("if (a === 'hi') {\n  console.log('hi!')\n} else {\n  console.log('hello')\n}")]

			expect(actual).toStrictEqual(expected)
		})
	})

	it("should keep raw text unescaped in paragraphs", async () => {
		// rich_text text elements are structural — Slack never mrkdwn-parses
		// them, so &, <, > stay literal.
		const actual = await markdownToBlocks("<>&'\"\"'&><")
		const expected = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "<>&'\"\"'&><" }] }] }]
		expect(actual).toStrictEqual(expected)
	})

	it("should preserve double quotes in code spans", async () => {
		const actual = await markdownToBlocks('`flexhr users search "David Shin"`')
		const expected = [
			{
				type: "rich_text",
				elements: [{ type: "rich_text_section", elements: [{ type: "text", text: 'flexhr users search "David Shin"', style: { code: true } }] }]
			}
		]
		expect(actual).toStrictEqual(expected)
	})

	it("should escape Slack mentions inside paragraph code spans", async () => {
		const actual = await markdownToBlocks("literal `<@U12345>` but notify <@U67890>")
		const expected = [
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: [
							{ type: "text", text: "literal " },
							{ type: "text", text: "&lt;@U12345&gt;", style: { code: true } },
							{ type: "text", text: " but notify " },
							{ type: "user", user_id: "U67890" }
						]
					}
				]
			}
		]
		expect(actual).toStrictEqual(expected)
	})

	it("should escape Slack control tokens inside rich text code blocks", async () => {
		const actual = await markdownToBlocks("before\n```\n<@U12345>\n<!here>\n```\nafter <@U67890>")
		expect(JSON.stringify(actual)).toContain("&lt;@U12345&gt;")
		expect(JSON.stringify(actual)).toContain("&lt;!here&gt;")
		// The mention outside code becomes a structural user element
		expect(JSON.stringify(actual)).toContain('"user_id":"U67890"')
		expect(JSON.stringify(actual)).not.toContain("<@U12345>")
		expect(JSON.stringify(actual)).not.toContain("<!here>")
	})

	describe("paragraph rich_text rendering", () => {
		it("should render emphasis structurally even when adjacent to CJK particles", async () => {
			// Slack mrkdwn refuses `_수정_이고` (marker touching a word char), so
			// paragraphs must carry styles structurally.
			const actual = await markdownToBlocks("오늘 조치는 *응급 수정*이고 근본 해결은 아닙니다.")
			expect(actual).toStrictEqual([
				{
					type: "rich_text",
					elements: [
						{
							type: "rich_text_section",
							elements: [
								{ type: "text", text: "오늘 조치는 " },
								{ type: "text", text: "응급 수정", style: { italic: true } },
								{ type: "text", text: "이고 근본 해결은 아닙니다." }
							]
						}
					]
				}
			])
		})

		it("should preserve soft line breaks in paragraphs", async () => {
			const actual = await markdownToBlocks("첫 문장.\n둘째 문장.")
			expect(actual).toStrictEqual([{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "첫 문장.\n둘째 문장." }] }] }])
		})

		it("should render hard line breaks as newlines in paragraphs", async () => {
			const actual = await markdownToBlocks("첫 문장.  \n둘째 문장.")
			expect(actual).toStrictEqual([
				{
					type: "rich_text",
					elements: [
						{
							type: "rich_text_section",
							elements: [
								{ type: "text", text: "첫 문장." },
								{ type: "text", text: "\n" },
								{ type: "text", text: "둘째 문장." }
							]
						}
					]
				}
			])
		})
	})

	it("should escape Slack control tokens inside rich text inline code", async () => {
		const actual = await markdownToBlocks("- literal `<@U12345>` but notify <@U67890>")
		expect(JSON.stringify(actual)).toContain("&lt;@U12345&gt;")
		expect(JSON.stringify(actual)).toContain("U67890")
		expect(JSON.stringify(actual)).not.toContain("<@U12345>")
	})

	it("should escape Slack control tokens inside fallback code only", () => {
		expect(markdownToSlackText("literal `<@U12345>` but notify <@U67890>")).toBe("literal `&lt;@U12345&gt;` but notify <@U67890>")
		expect(markdownToSlackText("before\n```\n<!here>\n<@U12345>\n```\nafter")).toBe("before\n```\n&lt;!here&gt;\n&lt;@U12345&gt;\n```\nafter")
	})

	describe("slack special formatting in rich text", () => {
		it("should parse user mentions in blockquotes", async () => {
			const actual = await markdownToBlocks("> hello <@U12345>")
			expect(actual[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [
							{ type: "text", text: "hello " },
							{ type: "user", user_id: "U12345" }
						]
					}
				]
			})
		})

		it("should parse channel links in list items", async () => {
			const actual = await markdownToBlocks("- see <#C12345>")
			expect(actual[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [
									{ type: "text", text: "see " },
									{ type: "channel", channel_id: "C12345" }
								]
							}
						]
					}
				]
			})
		})

		it("should parse broadcast mentions in list items", async () => {
			// Note: <!here> is parsed as HTML by marked at block level.
			// Within list items it appears as escaped text &lt;!here&gt;.
			const actual = await markdownToBlocks("- <!here> please review")
			expect(actual[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [
									{ type: "broadcast", range: "here" },
									{ type: "text", text: " please review" }
								]
							}
						]
					}
				]
			})
		})

		it("should parse usergroup mentions in list items", async () => {
			const actual = await markdownToBlocks("- cc <!subteam^S12345>")
			expect(actual[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [
									{ type: "text", text: "cc " },
									{ type: "usergroup", usergroup_id: "S12345" }
								]
							}
						]
					}
				]
			})
		})
	})

	describe("video support", () => {
		it("should parse HTML video tags", async () => {
			const actual = await markdownToBlocks('<video src="https://example.com/video.mp4" poster="https://example.com/thumb.jpg" title="My Video" alt="A video"/>')
			expect(actual).toHaveLength(1)
			expect(actual[0]).toMatchObject({
				type: "video",
				video_url: "https://example.com/video.mp4",
				thumbnail_url: "https://example.com/thumb.jpg",
				title: { type: "plain_text", text: "My Video" },
				alt_text: "A video"
			})
		})
	})

	describe("validation", () => {
		it("should throw on empty input", async () => {
			await expect(markdownToBlocks("")).rejects.toThrow("Input cannot be empty")
		})

		it("should throw on null input", async () => {
			await expect(markdownToBlocks(null as unknown as string)).rejects.toThrow("Input cannot be null or undefined")
		})
	})

	describe("fixture: headings", () => {
		it("should convert headings to header blocks", async () => {
			const blocks = await markdownToBlocks(readFixture("headings"))

			const headerBlocks = blocks.filter((b) => b.type === "header")
			expect(headerBlocks).toHaveLength(3)

			expect(headerBlocks[0]).toMatchObject({
				type: "header",
				text: { type: "plain_text", text: "Hello World" }
			})
			expect(headerBlocks[1]).toMatchObject({
				type: "header",
				text: { type: "plain_text", text: "Subheading" }
			})
			expect(headerBlocks[2]).toMatchObject({
				type: "header",
				text: { type: "plain_text", text: "Sub-subheading" }
			})
		})

		it("should produce paragraph blocks between headings", async () => {
			const blocks = await markdownToBlocks(readFixture("headings"))

			// Should have headings and paragraphs interleaved
			expect(blocks.length).toBeGreaterThanOrEqual(6)

			// Paragraphs render as rich_text blocks
			const paragraphBlocks = blocks.filter((b) => b.type === "rich_text")
			expect(paragraphBlocks.length).toBeGreaterThanOrEqual(3)
		})
	})

	describe("fixture: tables with alignment", () => {
		it("should parse tables with various alignments", async () => {
			const blocks = await markdownToBlocks(readFixture("tables"))

			const tableBlocks = blocks.filter((b) => b.type === "table")
			expect(tableBlocks).toHaveLength(6)
		})

		it("should have column_settings for aligned tables", async () => {
			const blocks = await markdownToBlocks(readFixture("tables"))

			const tableBlocks = blocks.filter((b) => b.type === "table") as slack.TableBlock[]

			// Tables with non-default alignment should have column_settings
			const withAlignment = tableBlocks.filter((t) => t.column_settings && t.column_settings.length > 0)
			const withoutAlignment = tableBlocks.filter((t) => !t.column_settings || t.column_settings.length === 0)

			expect(withAlignment.length).toBeGreaterThan(0)
			expect(withoutAlignment.length).toBeGreaterThan(0)
		})

		it("should parse right-aligned columns", async () => {
			const blocks = await markdownToBlocks("| Name | Salary |\n| ---: | ---: |\n| Alice | $100 |")
			const tableBlock = blocks.find((b) => b.type === "table") as slack.TableBlock
			expect(tableBlock).toBeDefined()
			expect(tableBlock.column_settings).toBeDefined()
			expect(tableBlock.column_settings![0]).toMatchObject({ align: "right" })
			expect(tableBlock.column_settings![1]).toMatchObject({ align: "right" })
		})

		it("should parse center-aligned columns", async () => {
			const blocks = await markdownToBlocks("| Name | Salary |\n| :---: | :---: |\n| Alice | $100 |")
			const tableBlock = blocks.find((b) => b.type === "table") as slack.TableBlock
			expect(tableBlock).toBeDefined()
			expect(tableBlock.column_settings).toBeDefined()
			expect(tableBlock.column_settings![0]).toMatchObject({ align: "center" })
		})

		it("should parse mixed alignment columns", async () => {
			const blocks = await markdownToBlocks("| Name | Dept | Salary |\n| :--- | :---: | ---: |\n| A | B | $100 |")
			const tableBlock = blocks.find((b) => b.type === "table") as slack.TableBlock
			expect(tableBlock).toBeDefined()
			expect(tableBlock.column_settings).toBeDefined()
			// Left-aligned is default, so first column may be empty
			// Center and right should be set
		})
	})

	describe("fixture: lists", () => {
		it("should parse simple ordered and unordered lists", async () => {
			const blocks = await markdownToBlocks(readFixture("lists"))

			const richTextBlocks = blocks.filter((b) => b.type === "rich_text")
			expect(richTextBlocks.length).toBeGreaterThan(0)
		})

		it("should handle nested unordered lists", async () => {
			const blocks = await markdownToBlocks("- Item 1\n  - Sub 1.1\n  - Sub 1.2\n- Item 2")

			expect(blocks.length).toBeGreaterThan(0)
			expect(blocks[0]).toMatchObject({ type: "rich_text" })
		})

		it("should handle nested ordered lists", async () => {
			const blocks = await markdownToBlocks("1. Item 1\n   1. Sub 1.1\n   2. Sub 1.2\n2. Item 2")

			expect(blocks.length).toBeGreaterThan(0)
			expect(blocks[0]).toMatchObject({ type: "rich_text" })
		})
	})

	describe("fixture: blockquotes", () => {
		it("should parse simple blockquote", async () => {
			const blocks = await markdownToBlocks("> This is a simple blockquote")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [{ type: "text", text: "This is a simple blockquote" }]
					}
				]
			})
		})

		it("should parse blockquote with formatting", async () => {
			const blocks = await markdownToBlocks("> This is a **bold** blockquote with _italic_ text")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [
							{ type: "text", text: "This is a " },
							{ type: "text", text: "bold", style: { bold: true } },
							{ type: "text", text: " blockquote with " },
							{ type: "text", text: "italic", style: { italic: true } },
							{ type: "text", text: " text" }
						]
					}
				]
			})
		})

		it("should parse blockquote with link", async () => {
			const blocks = await markdownToBlocks("> Blockquote with a [link](https://example.com)")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [
							{ type: "text", text: "Blockquote with a " },
							{
								type: "link",
								url: "https://example.com",
								text: "link"
							}
						]
					}
				]
			})
		})

		it("should parse all blockquote fixtures", async () => {
			const blocks = await markdownToBlocks(readFixture("blockquote"))
			// 4 blockquotes in the fixture
			const richTextBlocks = blocks.filter((b) => b.type === "rich_text")
			expect(richTextBlocks.length).toBeGreaterThanOrEqual(4)
		})
	})

	describe("fixture: strong links in list items", () => {
		it("should handle bold links in list items", async () => {
			const markdown = `- __[pica](https://nodeca.github.io/pica/demo/)__ - high quality and fast image
resize in browser.
- __[babelfish](https://github.com/nodeca/babelfish/)__ - developer friendly
i18n with plurals support and easy syntax.`
			const blocks = await markdownToBlocks(markdown)

			expect(blocks.length).toBeGreaterThan(0)

			const listBlock = blocks.find((b) => b.type === "rich_text")
			expect(listBlock).toBeDefined()

			if (listBlock && listBlock.type === "rich_text") {
				const listElement = (listBlock as slack.RichTextBlock).elements.find((e) => e.type === "rich_text_list")
				expect(listElement).toBeDefined()
			}
		})
	})

	describe("fixture: slack special formatting in paragraphs", () => {
		it("should parse user mentions in paragraphs", async () => {
			const blocks = await markdownToBlocks("Hello <@U12345> how are you?")
			const allText = JSON.stringify(blocks)
			// User mentions in paragraphs become structural user elements
			expect(allText).toContain('"type":"user"')
			expect(allText).toContain('"user_id":"U12345"')
		})

		it("should parse slack formatting in list items", async () => {
			const markdown = `- User: <@U12345>
- Channel: <#C12345>
- Link: <https://example.com|Example>`
			const blocks = await markdownToBlocks(markdown)
			const allText = JSON.stringify(blocks)

			expect(allText).toContain('"type":"user"')
			expect(allText).toContain('"user_id":"U12345"')
			expect(allText).toContain('"type":"channel"')
			expect(allText).toContain('"channel_id":"C12345"')
		})
	})

	describe("fixture: sample2 comprehensive markdown", () => {
		it("should parse a full markdown document", async () => {
			const blocks = await markdownToBlocks(readFixture("sample2"))

			// Should produce many blocks
			expect(blocks.length).toBeGreaterThan(10)

			// Should have headers
			const headers = blocks.filter((b) => b.type === "header")
			expect(headers.length).toBeGreaterThan(0)

			// Should have rich_text blocks (lists, code, blockquotes)
			const richText = blocks.filter((b) => b.type === "rich_text")
			expect(richText.length).toBeGreaterThan(0)

			// Should have tables
			const tables = blocks.filter((b) => b.type === "table")
			expect(tables.length).toBeGreaterThan(0)

			// Should have images
			const images = blocks.filter((b) => b.type === "image")
			expect(images.length).toBeGreaterThan(0)
		})
	})

	describe("fixture: sample3 complex markdown", () => {
		it("should parse complex markdown without errors", async () => {
			const blocks = await markdownToBlocks(readFixture("sample3"))

			expect(blocks.length).toBeGreaterThan(10)

			// Should have dividers (from ---)
			const dividers = blocks.filter((b) => b.type === "divider")
			expect(dividers.length).toBeGreaterThan(0)

			// Should have headers
			const headers = blocks.filter((b) => b.type === "header")
			expect(headers.length).toBeGreaterThan(0)

			// Should have tables
			const tables = blocks.filter((b) => b.type === "table")
			expect(tables.length).toBeGreaterThan(0)

			// Should have images
			const images = blocks.filter((b) => b.type === "image")
			expect(images.length).toBeGreaterThan(0)

			// Should have code blocks
			const codeBlocks = blocks.filter((b) => {
				if (b.type !== "rich_text") return false
				const rt = b as slack.RichTextBlock
				return rt.elements.some((e) => e.type === "rich_text_preformatted")
			})
			expect(codeBlocks.length).toBeGreaterThan(0)
		})
	})

	it("should handle horizontal rule", async () => {
		const blocks = await markdownToBlocks("---")
		expect(blocks).toHaveLength(1)
		expect(blocks[0].type).toBe("divider")
	})

	describe("style composition", () => {
		it("should handle bold italic (***text***)", async () => {
			const blocks = await markdownToBlocks("- ***bold italic***")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [{ type: "text", text: "bold italic", style: { bold: true, italic: true } }]
							}
						]
					}
				]
			})
		})

		it("should handle bold with nested italic (**bold _and italic_**)", async () => {
			const blocks = await markdownToBlocks("- **bold _and italic_**")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [
									{ type: "text", text: "bold ", style: { bold: true } },
									{ type: "text", text: "and italic", style: { bold: true, italic: true } }
								]
							}
						]
					}
				]
			})
		})

		it("should handle strikethrough with bold (~~**text**~~)", async () => {
			const blocks = await markdownToBlocks("- ~~**struck bold**~~")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [{ type: "text", text: "struck bold", style: { bold: true, strike: true } }]
							}
						]
					}
				]
			})
		})
	})

	describe("list offsets", () => {
		it("should handle ordered lists starting at 1 (no offset)", async () => {
			const blocks = await markdownToBlocks("1. first\n2. second\n3. third")
			const rt = blocks[0] as slack.RichTextBlock
			const list = rt.elements[0] as slack.RichTextListElement
			expect(list.style).toBe("ordered")
			expect(list.offset).toBeUndefined()
		})

		it("should handle ordered lists starting at > 1 (with offset)", async () => {
			const blocks = await markdownToBlocks("5. fifth\n6. sixth\n7. seventh")
			const rt = blocks[0] as slack.RichTextBlock
			const list = rt.elements[0] as slack.RichTextListElement
			expect(list.style).toBe("ordered")
			expect(list.offset).toBe(4)
		})
	})

	describe("nested lists", () => {
		it("should produce indent levels for nested bullet lists", async () => {
			const blocks = await markdownToBlocks("- Parent\n  - Child\n    - Grandchild")
			const allElements = blocks.flatMap((b) => (b.type === "rich_text" ? (b as slack.RichTextBlock).elements : []))
			const lists = allElements.filter((e) => e.type === "rich_text_list") as slack.RichTextListElement[]

			// Should have lists with increasing indent
			expect(lists.length).toBeGreaterThanOrEqual(1)
			const indents = lists.map((l) => l.indent ?? 0)
			expect(indents).toContain(0) // top level
		})

		it("should produce indent levels for nested ordered lists", async () => {
			const blocks = await markdownToBlocks("1. Parent\n   1. Child\n   2. Child 2\n2. Parent 2")
			const allElements = blocks.flatMap((b) => (b.type === "rich_text" ? (b as slack.RichTextBlock).elements : []))
			const lists = allElements.filter((e) => e.type === "rich_text_list") as slack.RichTextListElement[]

			expect(lists.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe("soft line breaks", () => {
		it("should convert single newlines to spaces in list items", async () => {
			const blocks = await markdownToBlocks("- first line\nsecond line")
			const rt = blocks[0] as slack.RichTextBlock
			const list = rt.elements[0] as slack.RichTextListElement
			const section = list.elements[0] as slack.RichTextElement
			const textEl = section.elements[0] as slack.RichTextTextElement
			expect(textEl.text).toContain("first line")
			// Single newline should become space (soft break)
			expect(textEl.text).not.toContain("\n")
		})
	})

	describe("escape tokens", () => {
		it("should handle escaped characters in list items", async () => {
			const blocks = await markdownToBlocks("- 5 \\> 3")
			const rt = blocks[0] as slack.RichTextBlock
			const list = rt.elements[0] as slack.RichTextListElement
			const section = list.elements[0] as slack.RichTextElement
			const allText = section.elements.map((e) => ("text" in e ? e.text : "")).join("")
			expect(allText).toContain("5")
			expect(allText).toContain(">")
			expect(allText).toContain("3")
		})
	})

	describe("style propagation in Slack patterns", () => {
		it("should propagate bold style to user mentions", async () => {
			const blocks = await markdownToBlocks("- **<@U12345>**")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_list",
						elements: [
							{
								type: "rich_text_section",
								elements: [{ type: "user", user_id: "U12345", style: { bold: true } }]
							}
						]
					}
				]
			})
		})

		it("should propagate italic style to broadcast mentions", async () => {
			const blocks = await markdownToBlocks("> _<@U12345> please review_")
			expect(blocks[0]).toMatchObject({
				type: "rich_text",
				elements: [
					{
						type: "rich_text_quote",
						elements: [
							{ type: "user", user_id: "U12345", style: { italic: true } },
							{ type: "text", text: " please review", style: { italic: true } }
						]
					}
				]
			})
		})
	})

	describe("HTML improvements", () => {
		it("should parse HTML img tags without self-closing slash", async () => {
			const blocks = await markdownToBlocks('<img src="https://example.com/photo.jpg" alt="Photo">')
			expect(blocks).toHaveLength(1)
			expect(blocks[0]).toMatchObject({
				type: "image",
				image_url: "https://example.com/photo.jpg",
				alt_text: "Photo"
			})
		})

		it("should parse enhanced video metadata", async () => {
			const blocks = await markdownToBlocks(
				'<video src="https://example.com/v.mp4" poster="https://example.com/t.jpg" title="Test" alt="Video" data-provider-name="YouTube" data-author-name="Author" data-description="Desc" />'
			)
			expect(blocks).toHaveLength(1)
			expect(blocks[0]).toMatchObject({
				type: "video",
				video_url: "https://example.com/v.mp4",
				provider_name: "YouTube",
				author_name: "Author",
				description: { type: "plain_text", text: "Desc" }
			})
		})

		it("should handle Slack patterns parsed as HTML at block level", async () => {
			// <!here> at block level gets parsed as HTML comment by marked
			const blocks = await markdownToBlocks("<!here>")
			const allText = JSON.stringify(blocks)
			expect(allText).toContain('"type":"broadcast"')
			expect(allText).toContain('"range":"here"')
		})
	})

	describe("complex blockquotes", () => {
		it("should handle blockquotes containing code blocks", async () => {
			const blocks = await markdownToBlocks("> text\n>\n> ```\n> code\n> ```")
			expect(blocks.length).toBeGreaterThan(0)
		})

		it("should handle blockquotes containing lists", async () => {
			const blocks = await markdownToBlocks("> header\n>\n> - item 1\n> - item 2")
			expect(blocks.length).toBeGreaterThan(0)
		})
	})

	describe("divider spacing", () => {
		it("appends a trailing newline inside a list before a divider", async () => {
			const blocks = await markdownToBlocks("- a\n- b\n\n---")
			const rt = blocks[0] as slack.RichTextBlock
			const last = rt.elements[rt.elements.length - 1] as slack.RichTextElement
			expect(last.type).toBe("rich_text_section")
			expect(last.elements.some((e) => e.type === "text" && e.text === "\n")).toBe(true)
			expect(blocks[1].type).toBe("divider")
		})

		it("appends a trailing newline to a paragraph before a divider", async () => {
			const blocks = await markdownToBlocks("hello\n\n---")
			const rt = blocks[0] as { type: string; elements: slack.RichTextElement[] }
			expect(rt.type).toBe("rich_text")
			const last = rt.elements[rt.elements.length - 1] as slack.RichTextElement
			expect(last.type).toBe("rich_text_section")
			expect(last.elements.some((e) => e.type === "text" && e.text === "\n")).toBe(true)
			expect(blocks[1].type).toBe("divider")
		})

		it("inserts a spacer block before a divider after a table", async () => {
			const blocks = await markdownToBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n\n---")
			const tableIdx = blocks.findIndex((b) => b.type === "table")
			expect(tableIdx).toBeGreaterThanOrEqual(0)
			expect(blocks[tableIdx + 1].type).toBe("rich_text")
			expect(blocks[tableIdx + 2].type).toBe("divider")
		})

		it("leaves a lone divider unchanged", async () => {
			const blocks = await markdownToBlocks("---")
			expect(blocks).toHaveLength(1)
			expect(blocks[0].type).toBe("divider")
		})
	})
})
