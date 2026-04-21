import { Command } from "commander";
import { loadUniverseFile } from "../../../services/universe";

type LoadFileCommandOptions = {
  slug: string;
  file?: string;
  dir?: string;
};

export const loadFileUniverseCommand = new Command("load-file")
  .description("Extract entities from a file or directory for a universe")
  .requiredOption("--slug <slug>", "Universe slug")
  .option("--file <filepath>", "Path to a single source file")
  .option("--dir <dirpath>", "Path to a source directory")
  .action(async (options: LoadFileCommandOptions) => {
    try {
      const result = await loadUniverseFile({
        slug: options.slug,
        filePath: options.file,
        dirPath: options.dir,
      });

      console.log(
        `Processed ${result.outputPaths.length} file(s) for universe '${options.slug}'.`,
      );

      console.log("Output files:");
      for (const outputPath of result.outputPaths) {
        console.log(`- ${outputPath}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }

      throw error;
    }
  });
