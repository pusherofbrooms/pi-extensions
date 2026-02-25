import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("show-system-prompt", {
        description: "View or save the effective system prompt",
        handler: async (args, ctx) => {
            const prompt = ctx.getSystemPrompt();

            // Non-interactive modes (print/rpc): just print
            if (!ctx.hasUI) {
                console.log(prompt);
                return;
            }

            if (args.trim() === "save") {
                const outPath = join(ctx.cwd, ".pi", "system-prompt.snapshot.md");
                await writeFile(outPath, prompt, "utf-8");
                ctx.ui.notify(`Saved system prompt to ${outPath}`, "info");
                return;
            }

            // Default: open in editable viewer so you can inspect/copy
            await ctx.ui.editor("Effective system prompt", prompt);
        },
    });
}