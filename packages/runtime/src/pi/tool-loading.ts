import type { ToolDefinition, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const ENTRY_TOOLS = new Set([
  "read", "write", "edit", "bash", "grep", "find", "ls", "codemode", "tool_search",
  "subagents_enable", "subagent", "subagent_supervisor",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
]);

/** Change model declarations through the SDK's public loader override. */
export function deferPluginTools(current: LoadExtensionsResult, hostMcp: boolean): LoadExtensionsResult {
  const extensions = current.extensions.filter(extension => !hostMcp || !(
    /^pi-mcp-adapter(?:@|$)/.test(extension.sourceInfo.source.replace(/^npm:/, "")) ||
    /[/\\]pi-mcp-adapter[/\\]/.test(extension.resolvedPath)
  ));
  for (const extension of extensions) {
    // Preserve this map: registerTool's closure adds dynamic MCP definitions to it.
    for (const [name, tool] of extension.tools) {
      // Keep model-only orchestration semantics and explicitly hidden tools intact.
      if (!ENTRY_TOOLS.has(name) && (!tool.definition.exposure || tool.definition.exposure === "direct")) {
        extension.tools.set(name, {
          ...tool,
          definition: { ...tool.definition, exposure: "deferred", defaultActive: false },
        });
      }
    }
  }
  return { ...current, extensions };
}

/** Recovery and plan/approval entry points stay direct; optional host features use the same public search path as plugins. */
export function deferHostTools(tools:ToolDefinition[]):ToolDefinition[] {
 const optional=new Set(["harness_subagent","save_memory","save_time_memory","list_time_memories"]);
 return tools.map(tool=>optional.has(tool.name) && (!tool.exposure || tool.exposure==="direct")
  ? {...tool,exposure:"deferred",defaultActive:false} : tool);
}
