/**
 * Toggle Ralph Wiggum extension tools on/off via /toggle-ralph.
 * Disables ralph_start and ralph_done so the LLM won't invoke them.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RALPH_TOOLS = ["ralph_start", "ralph_done"];

export default function (pi: ExtensionAPI) {
  let disabled = false;
  let savedTools: string[] | null = null;

  pi.registerCommand("toggle-ralph", {
    description: "Toggle ralph-wiggum tools on/off",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools().map((t) => t.name);
      const activeTools = pi.getActiveTools().map((t) => t.name);

      if (!disabled) {
        // Disable: remove ralph tools from active set
        savedTools = activeTools;
        const filtered = activeTools.filter((name) => !RALPH_TOOLS.includes(name));
        pi.setActiveTools(filtered);
        disabled = true;
        ctx.ui.notify("Ralph Wiggum tools disabled", "info");
      } else {
        // Enable: restore ralph tools
        const restored = savedTools ?? allTools;
        pi.setActiveTools(restored);
        savedTools = null;
        disabled = false;
        ctx.ui.notify("Ralph Wiggum tools enabled", "info");
      }
    },
  });
}
