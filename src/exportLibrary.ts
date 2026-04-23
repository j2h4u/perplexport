import { promises as fs } from "fs";
import * as path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { loadOrLogin } from "./login";
import { getConversations, Space } from "./listConversations";
import { loadThread } from "./ConversationSaver";
import renderConversation from "./renderConversation";
import { loadDoneFile, saveDoneFile, writeAtomic, fileExists, sleep } from "./utils";
import { THREAD_EXPORT_DELAY_MS } from "./config";

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email: string;
  cookiesFile: string;
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function renderSpaceMd(space: Space): string {
  const lines = [`# ${space.title}`, ""];
  if (space.description) lines.push(space.description, "");
  if (space.instructions) lines.push("## Instructions", "", space.instructions, "");

  // Placeholder section for space files (uploaded documents/images).
  // When the files API is discovered, downloaded files would be listed here
  // and saved into an _files/ subdirectory alongside this _space.md.
  lines.push("## Files", "", "_No files exported (API not yet available)_", "");

  return lines.join("\n");
}

/** Rename an existing directory to <dir>.backup (or .backup.2, .backup.3, …).
 *  Called before any destructive re-export so no data is ever silently lost. */
async function backupIfExists(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    return; // doesn't exist, nothing to back up
  }
  let dest = dir + ".backup";
  let n = 2;
  while (true) {
    try {
      await fs.access(dest);
      dest = `${dir}.backup.${n++}`;
    } catch {
      break;
    }
  }
  await fs.rename(dir, dest);
  console.log(`Backed up existing output to ${path.basename(dest)}`);
}

export default async function exportLibrary(options: ExportLibraryOptions) {
  puppeteer.use(StealthPlugin());

  await fs.mkdir(options.outputDir, { recursive: true });
  const doneFile = await loadDoneFile(options.doneFilePath);
  console.log(`${doneFile.processedUrls.length} already exported`);

  const browser = await (puppeteer as any).launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await loadOrLogin(browser, options.email, options.cookiesFile);
    const conversations = await getConversations(page, doneFile);

    let exported = 0;
    let skipped = 0;
    const writtenSpaces = new Set<string>();

    for (const conversation of conversations) {
      let dir = options.outputDir;
      if (conversation.space) {
        const folderName = sanitizeFolderName(conversation.space.title);
        dir = `${options.outputDir}/${folderName}`;
        await fs.mkdir(dir, { recursive: true });

        if (!writtenSpaces.has(conversation.space.uuid)) {
          writtenSpaces.add(conversation.space.uuid);
          await writeAtomic(`${dir}/_space.md`, renderSpaceMd(conversation.space));

          // TODO: Download space files here when API is available.
          // Something like:
          //   const files = await listSpaceFiles(page, conversation.space.slug);
          //   for (const file of files) await downloadFile(file, `${dir}/_files/`);
        }
      }

      const jsonPath = `${dir}/${conversation.uuid}.json`;
      const mdPath = `${dir}/${conversation.uuid}.md`;

      if (await fileExists(jsonPath) && await fileExists(mdPath)) {
        if (!doneFile.processedUrls.includes(conversation.url)) {
          doneFile.processedUrls.push(conversation.url);
          await saveDoneFile(doneFile, options.doneFilePath);
        }
        skipped++;
        continue;
      }

      console.log(`Exporting: ${conversation.title.substring(0, 70)}`);

      const { id, conversation: threadData } = await loadThread(page, conversation.uuid);

      await writeAtomic(jsonPath, JSON.stringify(threadData, null, 2));
      await writeAtomic(mdPath, renderConversation(threadData));

      doneFile.processedUrls.push(conversation.url);
      await saveDoneFile(doneFile, options.doneFilePath);

      exported++;
      await sleep(THREAD_EXPORT_DELAY_MS);
    }

    if (skipped > 0) console.log(`Skipped ${skipped} already-exported.`);
    console.log(`Done. Exported ${exported} new conversations.`);
  } finally {
    await browser.close();
  }
}

export { backupIfExists };
