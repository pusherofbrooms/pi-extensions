import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectDangerousCommand, detectSecret, getString } from "./guardrails-core.mjs";

export default function guardrailsExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = getString((event.input as Record<string, unknown>).path);
			const content =
				event.toolName === "write"
					? getString((event.input as Record<string, unknown>).content)
					: getString((event.input as Record<string, unknown>).newText);

			const matchName = detectSecret(content);
			if (matchName) {
				const reason = `Blocked ${event.toolName} to ${path || "<unknown path>"}: possible secret detected (${matchName}).`;
				if (ctx.hasUI) {
					ctx.ui.notify(reason, "warning");
				}
				return { block: true, reason };
			}

			return undefined;
		}

		if (event.toolName !== "bash") {
			return undefined;
		}

		const command = getString((event.input as Record<string, unknown>).command);
		const matchName = detectDangerousCommand(command);
		if (!matchName) {
			return undefined;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Dangerous bash command blocked in non-interactive mode (${matchName})`,
			};
		}

		const choice = await ctx.ui.select(
			`⚠️ Potentially destructive command detected (${matchName}):\n\n${command}\n\nAllow once?`,
			["Block", "Allow once"],
		);

		if (choice !== "Allow once") {
			return { block: true, reason: `Blocked dangerous command (${matchName})` };
		}

		ctx.ui.notify(`Allowed dangerous command once (${matchName})`, "warning");
		return undefined;
	});
}
