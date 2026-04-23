import { promises as fs } from "fs";
import * as path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { loadOrLogin } from "./login";
import { getConversations, Space, Conversation } from "./listConversations";
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

function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderSpaceMd(space: Space, threads: Conversation[]): string {
  const fm = ["---", `title: ${yamlStr(space.title)}`, "type: perplexity-space"];
  if (space.description) fm.push(`description: ${yamlStr(space.description)}`);
  fm.push("---");

  const parts: string[] = [fm.join("\n")];

  if (space.instructions) {
    parts.push("## Instructions\n\n" + space.instructions);
  }

  if (threads.length > 0) {
    parts.push("## Chats\n\n" + threads.map((t) => `- [[${t.uuid}.md|${t.title}]]`).join("\n"));
  }

  return parts.join("\n\n") + "\n";
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
    const allConversations = await getConversations(page);

    // Build space index and write _space.md files upfront with full thread lists
    const spaceMap = new Map<string, { space: Space; threads: Conversation[] }>();
    for (const c of allConversations) {
      if (!c.space) continue;
      if (!spaceMap.has(c.space.uuid)) {
        spaceMap.set(c.space.uuid, { space: c.space, threads: [] });
      }
      spaceMap.get(c.space.uuid)!.threads.push(c);
    }
    for (const { space, threads } of spaceMap.values()) {
      const dir = `${options.outputDir}/${sanitizeFolderName(space.title)}`;
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(`${dir}/_space.md`, renderSpaceMd(space, threads));
    }

    const todo = allConversations
      .filter((c) => !doneFile.processedUrls.includes(c.url))
      .reverse();
    console.log(`${todo.length} new to export`);

    let exported = 0;
    let skipped = 0;

    for (const conversation of todo) {
      let dir = options.outputDir;
      if (conversation.space) {
        const folderName = sanitizeFolderName(conversation.space.title);
        dir = `${options.outputDir}/${folderName}`;
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
      await writeAtomic(mdPath, renderConversation(threadData, conversation.space?.title));

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
