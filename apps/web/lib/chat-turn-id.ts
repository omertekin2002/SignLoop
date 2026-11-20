/**
 * Give each saved-chat user message one turn id. The chat runtime keeps a message's id when Retry
 * resends it and gives a new or edited message a new id, so keying by message id makes a retry
 * reuse its turn id (and the server replays the saved turn) while every new question gets its own.
 * A reloaded thread restores the ids its saved questions were sent with through `remember`, so a
 * Retry of a turn interrupted before the reload names that same turn and the server replaces it.
 */
export type ChatTurnIds = ((userMessageId: string) => string) & {
  remember: (userMessageId: string, turnId: string) => void;
};

export function createChatTurnIds(
  newId: () => string = () => crypto.randomUUID(),
): ChatTurnIds {
  const turnIds = new Map<string, string>();
  const turnIdFor = (userMessageId: string) => {
    let turnId = turnIds.get(userMessageId);
    if (!turnId) {
      turnId = newId();
      turnIds.set(userMessageId, turnId);
    }
    return turnId;
  };
  return Object.assign(turnIdFor, {
    remember: (userMessageId: string, turnId: string) => {
      turnIds.set(userMessageId, turnId);
    },
  });
}
