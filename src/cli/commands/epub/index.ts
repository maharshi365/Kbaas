import { Command } from "commander";
import { extractEpubCommand } from "./extract";

export const epubCommand = new Command("epub")
  .description("Parse and extract content from epub files")
  .addCommand(extractEpubCommand);
