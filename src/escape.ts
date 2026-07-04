export function escapeForSlackCode(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeDelimitedCode(text: string, markerChar: "`" | "~"): string {
	let out = ""
	let i = 0

	while (i < text.length) {
		const start = text.indexOf(markerChar, i)
		if (start === -1) {
			out += text.slice(i)
			break
		}

		out += text.slice(i, start)

		let markerEnd = start
		while (text[markerEnd] === markerChar) markerEnd++
		const markerLength = markerEnd - start

		// Markdown code spans are backtick-only. Tilde code fences require a run
		// of at least three markers; shorter runs are ordinary text.
		if (markerChar === "~" && markerLength < 3) {
			out += text.slice(start, markerEnd)
			i = markerEnd
			continue
		}

		const marker = markerChar.repeat(markerLength)
		const contentStart = markerEnd
		const close = text.indexOf(marker, contentStart)

		out += marker
		if (close === -1) {
			out += escapeForSlackCode(text.slice(contentStart))
			break
		}

		out += escapeForSlackCode(text.slice(contentStart, close))
		out += marker
		i = close + markerLength
	}

	return out
}

export function escapeMarkdownCodeForSlackText(markdown: string): string {
	return escapeDelimitedCode(escapeDelimitedCode(markdown, "`"), "~")
}
