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
  .option(
    "--backup",
    "Rename existing output dir to <dir>.backup before exporting (safe when restructuring)"
  )
  .requiredOption("-e, --email <email>", "Perplexity email")
  .parse();

const options = program.opts();

async function main(): Promise<void> {
  if (options.backup) {
    await backupIfExists(options.output);
  }
  await exportLibrary({
    outputDir: options.output,
    doneFilePath: options.doneFile,
    email: options.email,
    cookiesFile: options.cookies,
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
