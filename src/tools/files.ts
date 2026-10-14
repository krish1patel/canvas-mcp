import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";

const MAX_CHARS = 50_000;

async function canvasGet(path: string): Promise<any> {
  const base = process.env.CANVAS_BASE_URL!.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${process.env.CANVAS_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Canvas API ${res.status}: ${await res.text()}`);
  return res.json();
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "get_file_content",
    'Download a Canvas file and return its text. Use for module items of type "File" (pass the item\'s content_id as file_id). Supports PDF and plain-text files.',
    {
      course_id: z.number().describe("The Canvas course ID"),
      file_id: z
        .number()
        .describe("The file ID (content_id of a File module item)"),
    },
    async ({ course_id, file_id }) => {
      try {
        const meta = await canvasGet(`/courses/${course_id}/files/${file_id}`);
        const type: string = meta["content-type"] ?? "";
        const name: string = meta.display_name ?? `file ${file_id}`;

        // meta.url is a pre-signed download link; don't send the token to it
        const res = await fetch(meta.url);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());

        let text: string;
        if (type === "application/pdf") {
          const pdf = await getDocumentProxy(buf);
          ({ text } = (await extractText(pdf, { mergePages: true })) as {
            text: string;
          });
        } else if (type.startsWith("text/") || type === "application/json") {
          text = new TextDecoder().decode(buf);
        } else if (type === "text/html") {
          text = htmlToText(new TextDecoder().decode(buf));
        } else {
          return textResult(`Can't extract text from "${name}" (${type}).`);
        }

        const truncated = text.length > MAX_CHARS;
        return textResult(
          `# ${name}\n\n${text.slice(0, MAX_CHARS)}${
            truncated ? "\n\n[truncated]" : ""
          }`,
        );
      } catch (err) {
        return textResult(`Error reading file: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "get_page_content",
    'Read a Canvas wiki Page. Use for module items of type "Page" (pass the item\'s page_url).',
    {
      course_id: z.number().describe("The Canvas course ID"),
      page_url: z.string().describe("The page's url slug or ID"),
    },
    async ({ course_id, page_url }) => {
      try {
        const page = await canvasGet(
          `/courses/${course_id}/pages/${encodeURIComponent(page_url)}`,
        );
        return textResult(`# ${page.title}\n\n${htmlToText(page.body ?? "")}`);
      } catch (err) {
        return textResult(`Error reading page: ${(err as Error).message}`);
      }
    },
  );
}
