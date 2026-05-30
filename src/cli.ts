#!/usr/bin/env node

import { Command } from "commander";
import exportLibrary, { backupIfExists } from "./exportLibrary";

const program = new Command();

program
  .name("perplexport")
  .description("Export Perplexity conversations as markdown files")
  .version("2.1.0")
  .option("-o, --output <directory>", "Output directory for conversations", "./conversations")
  .option("-d, --done-file <file>", "Done file (tracks exported URLs)", "done.json")
  .option("-c, --cookies <file>", "Session cookies file (avoids re-login)", "session-cookies.json")
  .option("--backup", "Rename existing output dir to <dir>.backup before exporting")
  .option("-e, --email <email>", "Perplexity email (only needed when saved cookies are invalid)")
  .option(
    "--otp-fifo <path>",
    "Read the emailed OTP code from this named pipe instead of prompting (for non-interactive/agent use)",
  )
  .option(
    "--headful",
    "Run a visible browser (use with xvfb-run on a headless server) — helps pass Cloudflare on 2FA",
  )
  .action(async (opts) => {
    if (opts.backup) await backupIfExists(opts.output);
    await exportLibrary({
      outputDir: opts.output,
      doneFilePath: opts.doneFile,
      email: opts.email,
      cookiesFile: opts.cookies,
      otpFifo: opts.otpFifo,
      headful: opts.headful,
    });
  });

program.parseAsync().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
