import { Command } from "commander";
import * as p from "@clack/prompts";
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
    p.intro("load-file");

    const mode = options.dir ? "directory" : "file";
    p.log.info(`Mode: ${mode}`);
    p.log.info(`Universe: ${options.slug}`);

    if (options.file) {
      p.log.info(`File: ${options.file}`);
    }
    if (options.dir) {
      p.log.info(`Directory: ${options.dir}`);
    }

    const spinner = p.spinner();
    let completedCount = 0;
    let failedCount = 0;
    let totalFiles = 0;

    try {
      spinner.start("Discovering files...");

      const result = await loadUniverseFile({
        slug: options.slug,
        filePath: options.file,
        dirPath: options.dir,
        onProgress: (event) => {
          switch (event.type) {
            case "discovery":
              totalFiles = event.totalFiles;
              spinner.message(
                `Found ${event.totalFiles} file(s) in ${event.dirPath}`,
              );
              break;

            case "batch_start":
              spinner.message(
                `Batch ${event.batchNumber}/${event.totalBatches} — sending ${event.batchSize} file(s) to Gemini...`,
              );
              break;

            case "file_start":
              spinner.message(
                `[${event.index}/${event.total}] Extracting: ${event.fileName}`,
              );
              break;

            case "file_retry":
              spinner.message(
                `[${event.index}/${event.total}] Retry ${event.attempt}/${event.maxRetries}: ${event.fileName} — ${event.error}`,
              );
              break;

            case "file_done":
              completedCount++;
              spinner.message(
                `[${event.index}/${event.total}] Done: ${event.fileName}  (${completedCount} completed)`,
              );
              break;

            case "file_error":
              failedCount++;
              spinner.message(
                `[${event.index}/${event.total}] FAILED: ${event.fileName}  (${failedCount} failed)`,
              );
              break;

            case "batch_done":
              spinner.message(
                `Batch ${event.batchNumber}/${event.totalBatches} finished — ${event.succeeded} ok, ${event.failed} failed`,
              );
              break;
          }
        },
      });

      const totalProcessed = result.outputPaths.length + result.failedFiles.length;
      spinner.stop(
        `Processed ${totalProcessed} file(s): ${result.outputPaths.length} succeeded, ${result.failedFiles.length} failed.`,
      );

      // Output files summary
      if (result.outputPaths.length > 0) {
        p.log.success(`Output files (${result.outputPaths.length}):`);
        for (const outputPath of result.outputPaths) {
          p.log.step(`  ${outputPath}`);
        }
      }

      // Failed files summary
      if (result.failedFiles.length > 0) {
        p.log.warn(`Failed files (${result.failedFiles.length}):`);
        for (const failed of result.failedFiles) {
          p.log.error(`  ${failed.filePath}`);
          p.log.error(`    ${failed.error}`);
        }
      }

      if (result.failedFiles.length > 0) {
        p.outro(
          `Done with ${result.failedFiles.length} error(s). Review failed files above.`,
        );
        process.exitCode = 1;
      } else {
        p.outro("Done!");
      }
    } catch (error) {
      spinner.stop("Failed.");

      if (error instanceof Error) {
        p.log.error(error.message);
      } else {
        p.log.error(String(error));
      }

      p.outro("Aborted due to error.");
      process.exitCode = 1;
    }
  });
