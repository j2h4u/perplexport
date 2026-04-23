#!/usr/bin/env node

import { Command } from "commander";
import exportLibrary, { backupIfExists } from "./exportLibrary";

const program = new Command();

program
  .name("perplexport")
  .description("Export Perplexity conversations as markdown files")
  .version("1.0.0")
  .option("-o, --output <directory>", "Output directory for conversations", ".")
  .option("-d, --done-file <file>", "Done file (tracks exported URLs)", "done.json")
  .option("-c, --cookies <file>", "Session cookies file (avoids re-login)", "session-cookies.json")
  .option("--backup", "Rename existing output dir to <dir>.backup before exporting")
  .option("-e, --email <email>", "Perplexity email")
  .action(async (opts) => {
    if (!opts.email) {
      console.error("error: required option '-e, --email <email>' not specified");
      process.exit(1);
    }
    if (opts.backup) await backupIfExists(opts.output);
    await exportLibrary({
      outputDir: opts.output,
      doneFilePath: opts.doneFile,
      email: opts.email,
      cookiesFile: opts.cookies,
    });
  });


program.parseAsync().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
