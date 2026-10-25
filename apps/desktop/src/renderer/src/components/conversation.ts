import type { TranscriptMessage } from "@pi-harness/contracts";
import type { ToolCardState } from "../store.js";
export interface ConversationTurn {
  id: string;
  user: TranscriptMessage | null;
  messages: TranscriptMessage[];
  tools: ToolCardState[];
}
/** Group real message/tool IDs; replayed results and live cards share one display. */
export function conversationTurns(
  messages: TranscriptMessage[],
  cards: ToolCardState[],
  previous: ConversationTurn[] = [],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const owners = new Map<string, ConversationTurn>();
  const userTurns = new Map<string, ConversationTurn>();
  for (const message of messages) {
    if (message.role === "user") {
      const turn={ id: message.id, user: message, messages: [], tools: [] };
      turns.push(turn);userTurns.set(message.id,turn);
    }
    else {
      if (!turns.length)
        turns.push({ id: "intro", user: null, messages: [], tools: [] });
      const turn =
        (message.toolCallId ? owners.get(message.toolCallId) : undefined) ??
        turns[turns.length - 1]!;
      turn.messages.push(message);
      for (const call of message.toolCalls ?? []) owners.set(call.id, turn);
      if (message.toolCallId) owners.set(message.toolCallId, turn);
    }
  }
  for (const card of cards) {
    let turn =
      owners.get(card.toolCallId) ?? (card.turnId ? userTurns.get(card.turnId) : undefined);
    if (!turn) {
      if (!turns.length)
        turns.push({ id: "intro", user: null, messages: [], tools: [] });
      turn = turns[turns.length - 1]!;
    }
    turn.tools.push(card);
  }
  const old=new Map(previous.map(turn=>[turn.id,turn]));
  return turns.map(turn=>{
    const prior=old.get(turn.id);
    return prior && prior.user===turn.user && prior.messages.length===turn.messages.length && prior.tools.length===turn.tools.length && prior.messages.every((message,i)=>message===turn.messages[i]) && prior.tools.every((card,i)=>card===turn.tools[i]) ? prior : turn;
  });
}
export function turnAnchor(id: string): string {
  return `turn-${encodeURIComponent(id)}`;
}
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
