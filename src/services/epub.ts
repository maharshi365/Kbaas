import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import EPub from "epub";
import type { TocElement } from "epub";
import * as p from "@clack/prompts";
import TurndownService from "turndown";

type Chapter = {
  id: string;
  title: string;
  order: number;
  level: number;
  href: string;
  wordCount: number;
};

type ExtractedChapter = {
  id: string;
  title: string;
  markdown: string;
};

type ExtractEpubOptions = {
  filePath: string;
  outputDir: string;
};

function ensureFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!lstatSync(filePath).isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
}

function sanitizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizePrefix(prefix: string): string {
  return prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildFilename(
  index: number,
  title: string,
  totalChapters: number,
  prefix?: string,
): string {
  const padWidth = String(totalChapters).length;
  const paddedIndex = String(index + 1).padStart(padWidth, "0");
  const slug = sanitizeTitle(title) || `chapter-${paddedIndex}`;

  if (prefix) {
    const sanitizedPrefix = sanitizePrefix(prefix);
    return `${sanitizedPrefix}-${paddedIndex}-${slug}.md`;
  }
  return `${paddedIndex}-${slug}.md`;
}

function countWordsInHtml(html: string): number {
  // Strip HTML tags, then count whitespace-delimited tokens
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return 0;
  return text.split(" ").length;
}

function formatWordCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function tocToChapters(
  toc: TocElement[],
  wordCounts: Map<string, number>,
): Chapter[] {
  return toc.map((entry) => ({
    id: entry.id,
    title: entry.title || `Untitled (${entry.id})`,
    order: entry.order,
    level: entry.level,
    href: entry.href,
    wordCount: wordCounts.get(entry.id) ?? 0,
  }));
}

/**
 * Resolve a chapter to a manifest ID that epub.getChapter() can use.
 *
 * TOC entries often have hrefs with fragment anchors (e.g. "chapter1.xhtml#part1")
 * or navPoint IDs that don't correspond to manifest keys. This function strips
 * the fragment from the href and searches the manifest for a matching entry.
 */
function resolveManifestId(
  epub: EPub,
  chapter: Chapter,
): string | null {
  // If the chapter.id already exists in the manifest, use it directly
  if (epub.manifest[chapter.id]) {
    return chapter.id;
  }

  // Strip fragment anchor from href and search manifest by href
  const hrefWithoutFragment = chapter.href.split("#")[0] ?? "";

  for (const [manifestId, item] of Object.entries(epub.manifest)) {
    if (item.href === hrefWithoutFragment) {
      return manifestId;
    }
  }

  // Try matching just the filename portion in case of path differences
  const chapterFilename = hrefWithoutFragment.split("/").pop() ?? "";
  if (chapterFilename) {
    for (const [manifestId, item] of Object.entries(epub.manifest)) {
      const manifestFilename = item.href.split("/").pop() ?? "";
      if (manifestFilename === chapterFilename) {
        return manifestId;
      }
    }
  }

  return null;
}

async function parseEpub(filePath: string): Promise<EPub> {
  const epub = new EPub(filePath);
  await epub.parse();
  return epub;
}

function createTurndownService(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
}

async function convertChapterToMarkdown(
  epub: EPub,
  chapter: Chapter,
  turndown: TurndownService,
): Promise<ExtractedChapter> {
  const manifestId = resolveManifestId(epub, chapter);
  if (!manifestId) {
    throw new Error(
      `Could not resolve chapter "${chapter.title}" (id: ${chapter.id}, href: ${chapter.href}) to a manifest entry.`,
    );
  }

  const html = await epub.getChapter(manifestId);
  const markdown = turndown.turndown(html);
  return {
    id: chapter.id,
    title: chapter.title,
    markdown,
  };
}

function writeChapterFile(
  chapter: ExtractedChapter,
  filename: string,
  outputDir: string,
): void {
  const header = `# ${chapter.title}\n\n`;
  const content = header + chapter.markdown.trim() + "\n";
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, content, "utf-8");
}

export async function extractEpub(options: ExtractEpubOptions): Promise<void> {
  const { filePath, outputDir } = options;

  p.intro("epub extract");

  // Validate input file
  ensureFile(filePath);

  // Parse epub
  const s = p.spinner();
  s.start("Parsing epub file...");

  let epub: EPub;
  try {
    epub = await parseEpub(filePath);
  } catch (error) {
    s.stop("Failed to parse epub file.");
    throw error;
  }

  // Pre-fetch word counts for all TOC entries
  s.message("Counting words per chapter...");
  const wordCounts = new Map<string, number>();
  for (const tocEntry of epub.toc) {
    const manifestId = resolveManifestId(epub, {
      id: tocEntry.id,
      href: tocEntry.href,
    } as Chapter);
    if (manifestId) {
      try {
        const html = await epub.getChapter(manifestId);
        wordCounts.set(tocEntry.id, countWordsInHtml(html));
      } catch {
        wordCounts.set(tocEntry.id, 0);
      }
    }
  }

  const chapters = tocToChapters(epub.toc, wordCounts);
  const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
  s.stop(
    `Parsed "${epub.metadata.title || "Unknown"}" by ${epub.metadata.creator || "Unknown"} - ${chapters.length} chapters, ${formatWordCount(totalWords)} words total.`,
  );

  if (chapters.length === 0) {
    p.log.warn("No chapters found in the table of contents.");
    p.outro("Nothing to extract.");
    return;
  }

  // Prompt for filename prefix (suggest book title)
  const suggestedPrefix = sanitizePrefix(
    epub.metadata.title || "book",
  );

  const prefix = await p.text({
    message: "Filename prefix for output files:",
    placeholder: suggestedPrefix,
    defaultValue: suggestedPrefix,
    validate(value: string | undefined) {
      if (!value || value.trim().length === 0) {
        return "Prefix cannot be empty.";
      }
    },
  });

  if (p.isCancel(prefix)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  // Prompt for chapter selection (auto-select chapters with >1000 words)
  const AUTOSELECT_WORD_THRESHOLD = 1000;
  const indentChar = "  ";
  const selectedChapterIndexes = await p.multiselect({
    message: `Select chapters to extract (chapters > ${AUTOSELECT_WORD_THRESHOLD} words are pre-selected):`,
    options: chapters.map((ch, idx) => ({
      value: idx,
      label: `${indentChar.repeat(ch.level)}${ch.title}`,
      hint: `${formatWordCount(ch.wordCount)} words`,
    })),
    initialValues: chapters
      .map((ch, idx) => ({ idx, wordCount: ch.wordCount }))
      .filter((x) => x.wordCount > AUTOSELECT_WORD_THRESHOLD)
      .map((x) => x.idx),
    required: true,
  });

  if (p.isCancel(selectedChapterIndexes)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const selectedChapters = selectedChapterIndexes.map((idx) => chapters[idx]!);

  p.log.info(
    `Extracting ${selectedChapters.length} chapter${selectedChapters.length === 1 ? "" : "s"}...`,
  );

  // Create output directory
  mkdirSync(outputDir, { recursive: true });

  // Convert and write chapters
  const turndown = createTurndownService();
  const s2 = p.spinner();
  s2.start("Converting chapters to markdown...");

  const written: string[] = [];

  for (let i = 0; i < selectedChapters.length; i++) {
    const chapter = selectedChapters[i]!;
    s2.message(`Converting (${i + 1}/${selectedChapters.length}): ${chapter.title}`);

    try {
      const extracted = await convertChapterToMarkdown(epub, chapter, turndown);
      const filename = buildFilename(i, chapter.title, selectedChapters.length, prefix);
      writeChapterFile(extracted, filename, outputDir);
      written.push(filename);
    } catch (error) {
      s2.stop(`Failed on chapter: ${chapter.title}`);
      throw error;
    }
  }

  s2.stop(`Converted ${written.length} chapter${written.length === 1 ? "" : "s"}.`);

  // Summary
  p.log.success(`Output directory: ${outputDir}`);
  for (const file of written) {
    p.log.step(`  ${file}`);
  }

  p.outro("Done!");
}
