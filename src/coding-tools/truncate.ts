export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate content to the first N lines / first N bytes, whichever
 * limit is hit first. Never returns a partial line.
 */
export function truncateHead(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";

  return {
    content: out.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: bytes,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}
