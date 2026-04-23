import {
  ConversationResponse,
  ConversationEntry,
  EntryStep,
  FinalAnswer,
  WebResult,
} from "./types/conversation";

function parseFinalAnswer(entry: ConversationEntry): FinalAnswer | null {
  try {
    const steps: EntryStep[] = JSON.parse(entry.text);
    const final = steps.find((s) => s.step_type === "FINAL");
    if (!final?.content?.answer) return null;
    return JSON.parse(final.content.answer as string) as FinalAnswer;
  } catch {
    return null;
  }
}

export default function renderConversation(
  conversation: ConversationResponse,
  space?: string
): string {
  const { entries } = conversation;
  if (entries.length === 0) return "";

  const rawTitle = entries[0].thread_title || entries[0].query_str;
  const title = rawTitle.split("\n")[0].trim().slice(0, 120);

  const fmLines = [
    `title: ${JSON.stringify(title)}`,
    `type: perplexity-thread`,
  ];
  if (space) fmLines.push(`collection: ${JSON.stringify(space)}`);
  fmLines.push(
    `created_at: ${entries[0].updated_datetime}`,
    `updated_at: ${entries[entries.length - 1].updated_datetime}`
  );

  const items = [`---\n${fmLines.join("\n")}\n---`];

  entries.forEach((entry, entryIndex) => {
    if (entryIndex > 0) items.push("* * *");

    const queryLines = entry.query_str.split("\n");
    items.push(`# ${queryLines[0]}`);
    items.push(`>[!important] ${entry.query_str.split("\n").join("\n> ")}`);

    const finalAnswer = parseFinalAnswer(entry);

    if (finalAnswer?.answer) {
      items.push(cleanupAnswer(finalAnswer.answer, entryIndex));
    }

    if (finalAnswer?.web_results?.length) {
      items.push(renderSources(finalAnswer.web_results, entryIndex));
    }
  });

  return items.join("\n\n");
}

function cleanupAnswer(answer: string, entryIndex: number): string {
  return answer
    .replace(/\[(.*?)\]\(pplx:\/\/.*?\)/g, "$1")
    .replace(/\[(\d+)\]/g, (_, num) => ` [[#^${entryIndex + 1}-${num}]] `);
}

function renderSources(webResults: WebResult[], entryIndex: number): string {
  let text = `## ${webResults.length} Sources\n\n`;
  webResults.forEach((result, index) => {
    const citation = index + 1;
    if (result.url?.startsWith("http")) {
      text += `- [${result.name}](${result.url}) ${hostLabel(result.url)}`;
    } else {
      text += `- ${result.name} (${result.url ?? ""})`;
    }
    if (result.snippet) text += `\n    ${result.snippet}`;
    text += ` ^${entryIndex + 1}-${citation}\n`;
  });
  return text;
}

function hostLabel(url: string): string {
  try {
    return `(${new URL(url).hostname.replace("www.", "")})`;
  } catch {
    return "";
  }
}
