/**
 * Input validation and sanitization utilities
 */

import { ValidationError } from "./errors"

const MAX_INPUT_SIZE = 1_000_000 // 1MB limit
const MAX_RECURSION_DEPTH = 50
const BLOCK_LIMIT = 50

/**
 * Validates markdown input before parsing
 */
export function validateInput(input: string | null | undefined): void {
	if (input === null || input === undefined) {
		throw new ValidationError("Input cannot be null or undefined")
	}

	if (typeof input !== "string") {
		throw new ValidationError(`Expected string input, received ${typeof input}`)
	}

	if (input.length === 0) {
		throw new ValidationError("Input cannot be empty")
	}

	if (input.length > MAX_INPUT_SIZE) {
		throw new ValidationError(`Input size ${input.length} exceeds maximum of ${MAX_INPUT_SIZE} bytes`)
	}
}

/**
 * Validates a URL is safe to use
 */
export function validateUrl(url: string | null | undefined): boolean {
	if (!url || typeof url !== "string" || url.length === 0) {
		return false
	}

	// Allow data: URLs only if they're images
	if (url.startsWith("data:")) {
		return url.startsWith("data:image/")
	}

	// Allow relative URLs
	if (url.startsWith("/") || url.startsWith(".")) {
		return true
	}

	// Validate absolute URLs
	const httpRegex = /^https?:\/\/[a-zA-Z0-9-._~:/?#[\]@!$&'()*+,;=]+$/
	if (!httpRegex.test(url)) {
		return false
	}

	return true
}

/**
 * Validates block count against Slack's limits
 */
export function validateBlockCount(blockCount: number, maxBlocks: number = BLOCK_LIMIT): void {
	if (blockCount > maxBlocks) {
		throw new ValidationError(`Block count ${blockCount} exceeds maximum of ${maxBlocks} blocks`)
	}
}

/**
 * Checks recursion depth to prevent stack overflow
 */
export function validateRecursionDepth(depth: number): void {
	if (depth > MAX_RECURSION_DEPTH) {
		throw new ValidationError(`Recursion depth ${depth} exceeds maximum of ${MAX_RECURSION_DEPTH}`)
	}
}

/**
 * Safely truncates text while respecting UTF-16 surrogate pair boundaries
 */
export function safeTruncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text
	}

	let truncated = text.slice(0, maxLength)

	// Check if we're in the middle of a UTF-16 surrogate pair
	const lastChar = truncated.charCodeAt(truncated.length - 1)
	if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
		// High surrogate without low surrogate - remove it
		truncated = truncated.slice(0, -1)
	}

	return truncated
}

/**
 * Configuration for secure XML parsing (prevents XXE attacks)
 */
export const SECURE_XML_CONFIG = {
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	parseTagValue: false,
	processEntities: false,
	htmlEntities: true,
	ignoreDeclaration: true,
	ignoreNameSpace: true,
	parseAttributeValue: false,
	cdataTagName: false,
	cdataValue: false
}

export const MAX_BLOCKS = BLOCK_LIMIT
export const MAX_INPUT_SIZE_BYTES = MAX_INPUT_SIZE
export const MAX_RECURSION = MAX_RECURSION_DEPTH
