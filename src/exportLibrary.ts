import { promises as fs } from "fs";
import * as path from "path";
import { Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { loadOrLogin } from "./login";
import { getConversations, Space, Conversation } from "./listConversations";
import { loadLatestThreadEntry, loadThread } from "./ConversationSaver";
import renderConversation from "./renderConversation";
import { loadDoneFile, saveDoneFile, writeAtomic, fileExists, sleep, DoneFile } from "./utils";
import { THREAD_EXPORT_DELAY_MS } from "./config";

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email?: string;
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

function conversationDir(outputDir: string, conversation: Conversation): string {
  if (!conversation.space) return outputDir;
  return `${outputDir}/${sanitizeFolderName(conversation.space.title)}`;
}

interface LocalConversationState {
  latestEntryUuid?: string;
  latestUpdatedDatetime?: string;
}

function readLocalConversationState(entries: unknown): LocalConversationState | undefined {
  if (!Array.isArray(entries)) return undefined;

  let latestUpdatedDatetime: string | undefined;
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "updated_datetime" in entry &&
      typeof entry.updated_datetime === "string" &&
      (!latestUpdatedDatetime || entry.updated_datetime > latestUpdatedDatetime)
    ) {
      latestUpdatedDatetime = entry.updated_datetime;
    }
  }

  const latestEntry = entries[entries.length - 1];
  const latestEntryUuid =
    typeof latestEntry === "object" &&
    latestEntry !== null &&
    "uuid" in latestEntry &&
    typeof latestEntry.uuid === "string"
      ? latestEntry.uuid
      : undefined;

  return { latestEntryUuid, latestUpdatedDatetime };
}

async function localConversationState(jsonPath: string): Promise<LocalConversationState | undefined> {
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as { entries?: unknown };
    return readLocalConversationState(data.entries);
  } catch {
    return undefined;
  }
}

async function needsSpaceRefresh(conversation: Conversation, jsonPath: string): Promise<boolean> {
  if (!conversation.space || !conversation.lastQueryDatetime) return false;

  const localState = await localConversationState(jsonPath);
  return (
    !localState?.latestUpdatedDatetime ||
    conversation.lastQueryDatetime > localState.latestUpdatedDatetime
  );
}

async function needsMainRefresh(
  page: Page,
  conversation: Conversation,
  jsonPath: string
): Promise<boolean> {
  if (conversation.space) return false;

  const localState = await localConversationState(jsonPath);
  if (!localState?.latestEntryUuid) return true;

  const remoteLatestEntry = await loadLatestThreadEntry(page, conversation.uuid);
  return !remoteLatestEntry?.uuid || remoteLatestEntry.uuid !== localState.latestEntryUuid;
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

    const processedUrls = new Set(doneFile.processedUrls);
    const todo: Array<{ conversation: Conversation; refreshExisting: boolean }> = [];
    let newCount = 0;
    let refreshCount = 0;

    for (const conversation of [...allConversations].reverse()) {
      const dir = conversationDir(options.outputDir, conversation);
      const jsonPath = `${dir}/${conversation.uuid}.json`;

      if (!processedUrls.has(conversation.url)) {
        todo.push({ conversation, refreshExisting: false });
        newCount++;
        continue;
      }

      if (await needsSpaceRefresh(conversation, jsonPath)) {
        todo.push({ conversation, refreshExisting: true });
        refreshCount++;
        continue;
      }

      if (await needsMainRefresh(page, conversation, jsonPath)) {
        todo.push({ conversation, refreshExisting: true });
        refreshCount++;
      }
    }

    console.log(`${newCount} new, ${refreshCount} updated conversations to export`);

    let exported = 0;
    let refreshed = 0;
    let skipped = 0;

    for (const { conversation, refreshExisting } of todo) {
      const dir = conversationDir(options.outputDir, conversation);

      const jsonPath = `${dir}/${conversation.uuid}.json`;
      const mdPath = `${dir}/${conversation.uuid}.md`;

      if (!refreshExisting && await fileExists(jsonPath) && await fileExists(mdPath)) {
        if (!processedUrls.has(conversation.url)) {
          doneFile.processedUrls.push(conversation.url);
          processedUrls.add(conversation.url);
          await saveDoneFile(doneFile, options.doneFilePath);
        }
        skipped++;
        continue;
      }

      console.log(`${refreshExisting ? "Refreshing" : "Exporting"}: ${conversation.title.substring(0, 70)}`);

      const { conversation: threadData } = await loadThread(page, conversation.uuid);

      await writeAtomic(jsonPath, JSON.stringify(threadData, null, 2));
      await writeAtomic(mdPath, renderConversation(threadData, conversation.space?.title));

      if (!processedUrls.has(conversation.url)) {
        doneFile.processedUrls.push(conversation.url);
        processedUrls.add(conversation.url);
        await saveDoneFile(doneFile, options.doneFilePath);
      }

      if (refreshExisting) refreshed++;
      else exported++;
      await sleep(THREAD_EXPORT_DELAY_MS);
    }

    if (skipped > 0) console.log(`Skipped ${skipped} already-exported.`);
    console.log(`Done. Exported ${exported} new conversations, refreshed ${refreshed}.`);
  } finally {
    await browser.close();
  }
}

export { backupIfExists };
