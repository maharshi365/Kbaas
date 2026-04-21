import { Command } from "commander";
import { resolve } from "node:path";
import { extractEpub } from "../../../services/epub";

type ExtractEpubCommandOptions = {
  file: string;
  out: string;
};

export const extractEpubCommand = new Command("extract")
  .description("Extract chapters from an epub file to markdown")
  .requiredOption("--file <path>", "Path to the epub file")
  .requiredOption("--out <dir>", "Output directory for markdown files")
  .action(async (options: ExtractEpubCommandOptions) => {
    try {
      await extractEpub({
        filePath: resolve(options.file),
        outputDir: resolve(options.out),
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        throw error;
      }
      process.exitCode = 1;
    }
  });
