/**
 * pi 会话事件 → 契约事件（task:stream / task:state）的映射层。
 * 渲染进程只认契约形状；pi 类型不越过此边界。
 */
import { randomUUID } from "node:crypto";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EventPayload, TranscriptMessage, ConversationReference } from "@pi-harness/contracts";

export type StreamPayload = EventPayload<"task:stream">;
export type StatePayload = EventPayload<"task:state">;

export interface MappedEvent {
	stream?: StreamPayload;
	state?: StatePayload;
	/** 相位事件（压缩等） */
	phase?: { phase: string; detail?: string };
}

/** 把 pi 消息对象转成 UI 转录模型（快照用；流式期间由增量事件驱动）。 */
export function toTranscriptMessage(message: unknown, index: number): TranscriptMessage | null {
	const m = message as {
		role: string;
		content?: unknown;
		timestamp?: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		usage?: Record<string, unknown>;
 details?: {harnessOutputId?: string};
	};
	if (!m || typeof m !== "object") return null;
	if (m.role === "user") {
		const content = m.content as string | Array<{ type: string; text?: string }> | undefined;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("")
					: "";
		return { id: `m${index}`, role: "user", text, timestamp: m.timestamp };
	}
	if (m.role === "assistant") {
		const blocks = (m.content ?? []) as Array<{
			type: string;
			text?: string;
			thinking?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
		}>;
		return {
			id: `m${index}`,
			role: "assistant",
			text: blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
			thinking:
				blocks
					.filter((b) => b.type === "thinking")
					.map((b) => b.thinking ?? "")
					.join("") || undefined,
			toolCalls:
				blocks.filter((b) => b.type === "toolCall").length > 0
					? blocks
							.filter((b) => b.type === "toolCall")
							.map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.arguments }))
					: undefined,
			usage: m.usage
				? {
						input: m.usage.input as number | undefined,
						output: m.usage.output as number | undefined,
						cacheRead: m.usage.cacheRead as number | undefined,
						cacheWrite: m.usage.cacheWrite as number | undefined,
						totalTokens: m.usage.totalTokens as number | undefined,
					}
				: undefined,
			timestamp: m.timestamp,
		};
	}
	if (m.role === "toolResult") {
		const content = (m.content ?? []) as Array<{ type: string; text?: string }>;
		return {
			id: `m${index}`,
			role: "toolResult",
			toolCallId: m.toolCallId,
			toolName: m.toolName,
 outputId: m.details?.harnessOutputId,
			isError: m.isError,
			text: content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("")
				.slice(0, m.details?.harnessOutputId ? 4000 : 20_000),
			timestamp: m.timestamp,
		};
	}
	return null;
}

/** 把隐藏的引用标记附在对应用户消息上，历史回看仍能看到引用来源。 */
export function toTranscript(messages: unknown[], entryIds?: string[]): TranscriptMessage[] {
 const transcript: TranscriptMessage[] = [];
 let references: ConversationReference[] | undefined;
 messages.forEach((message, index) => {
  const marker = message as {role?:string;customType?:string;details?:{references?:ConversationReference[]}};
  if(marker.role === "custom" && marker.customType === "harness_session_references") {
   references = marker.details?.references; return;
  }
  const mapped=toTranscriptMessage(message,index);
  if(!mapped)return;
  if(entryIds?.[index])mapped.entryId=entryIds[index];
  if(mapped.role === "user") { mapped.references=references; references=undefined; }
  transcript.push(mapped);
 });
 return transcript;
}

export function toTranscriptEntries(entries: SessionEntry[]): TranscriptMessage[] {
 const messages: unknown[] = [], ids: string[] = [];
 for(const entry of entries) {
  if(entry.type !== "message" && entry.type !== "custom_message")continue;
  for(const message of sessionEntryToContextMessages(entry)){messages.push(message);ids.push(entry.id);}
 }
 const transcript=toTranscript(messages,ids);
 for(const entry of entries){
  if(entry.type!=="custom" || entry.customType!=="harness_turn_timing")continue;
  const timing=entry.data as {entryId?:string;durationMs?:number;outcome?:TranscriptMessage["turnOutcome"]};
  const user=transcript.find(message=>message.role==="user" && message.entryId===timing?.entryId);
  if(user && typeof timing.durationMs==="number" && Number.isFinite(timing.durationMs) && timing.durationMs>=0){user.turnDurationMs=Math.round(timing.durationMs);user.turnOutcome=timing.outcome;}
 }
 return transcript;
}

/** 有状态映射器：跟踪工具耗时，输出契约事件。 */
export class SessionEventMapper {
 #requestError: string | undefined;
	#taskId: string;
	#toolStarts = new Map<string, number>();
	#messageSeq = 0;
	#messagePrefix = randomUUID();

	constructor(taskId: string) {
		this.#taskId = taskId;
	}

	map(event: AgentSessionEvent): MappedEvent | null {
		switch (event.type) {
			case "message_update": {
				const ame = event.assistantMessageEvent as { type: string; delta?: string };
				if (ame.type === "text_delta" && ame.delta) {
					return { stream: { taskId: this.#taskId, kind: "text_delta", delta: ame.delta } };
				}
				if (ame.type === "thinking_delta" && ame.delta) {
					return { stream: { taskId: this.#taskId, kind: "thinking_delta", delta: ame.delta } };
				}
				return null;
			}
			case "message_end": {
				if (event.message?.role !== "assistant") return null;
				const mapped = toTranscriptMessage(event.message, this.#messageSeq++);
				if (mapped) mapped.id = `live-${this.#messagePrefix}-${mapped.id}`;
				const asst = event.message as unknown as { stopReason?: string; errorMessage?: string };
				if (asst.stopReason === "error") {
					this.#requestError=asst.errorMessage ?? "模型请求失败";
                    return null;
				}
                this.#requestError=undefined;
				return {
					stream: {
						taskId: this.#taskId,
						kind: "assistant_message_end",
						message: mapped ?? undefined,
						usage: mapped?.usage,
					},
				};
			}
			case "tool_execution_start": {
				this.#toolStarts.set(event.toolCallId, Date.now());
				return {
					stream: {
						taskId: this.#taskId,
						kind: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					},
				};
			}
			case "tool_execution_update": {
				return {
					stream: { taskId: this.#taskId, kind: "tool_execution_update", toolCallId: event.toolCallId },
				};
			}
			case "tool_execution_end": {
				const started = this.#toolStarts.get(event.toolCallId);
				this.#toolStarts.delete(event.toolCallId);
				const result = event.result as { content?: Array<{ type: string; text?: string }>; details?: {harnessOutputId?: string} } | undefined;
				const resultPreview = result?.content
					?.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("")
					.slice(0, 4000);
				return {
					stream: {
						taskId: this.#taskId,
						kind: "tool_execution_end",
						toolCallId: event.toolCallId,
						isError: event.isError,
						durationMs: started !== undefined ? Date.now() - started : undefined,
						resultPreview,
 outputId: result?.details?.harnessOutputId,
					},
				};
			}
			case "queue_update": {
				return {
					stream: {
						taskId: this.#taskId,
						kind: "queue_update",
						steering: [...event.steering],
						followUp: [...event.followUp],
					},
				};
			}
			case "compaction_start": {
				return {
					phase: { phase: "compaction_start", detail: "正在整理上下文，保留目标与关键进展" },
				};
			}
			case "compaction_end": {
				return {
					phase: { phase: "compaction_end", detail: event.aborted ? "压缩已中止" : event.errorMessage ? `上下文压缩失败：${event.errorMessage}` : "上下文压缩完成" },
				};
			}
            case "agent_start": {
                this.#requestError=undefined;
                return null;
            }
            case "auto_retry_start": {
                return {state:{taskId:this.#taskId,status:"running",detail:`模型请求正在重试（${event.attempt}/${event.maxAttempts}）`}};
            }
            case "auto_retry_end": {
                if(event.success)this.#requestError=undefined;
                else if(event.finalError)this.#requestError=event.finalError;
                return event.success ? {state:{taskId:this.#taskId,status:"running"}} : null;
            }
			case "agent_settled": {
                return {state:{taskId:this.#taskId,status:this.#requestError ? "error" : "done",...(this.#requestError ? {detail:this.#requestError} : {})}};
			}
			default:
				return null;
		}
	}
}
