/**
 * Give each saved-chat user message one turn id. The chat runtime keeps a message's id when Retry
 * resends it and gives a new or edited message a new id, so keying by message id makes a retry
 * reuse its turn id (and the server replays the saved turn) while every new question gets its own.
 */
export function createChatTurnIds(
  newId: () => string = () => crypto.randomUUID(),
): (userMessageId: string) => string {
  const turnIds = new Map<string, string>();
  return (userMessageId) => {
    let turnId = turnIds.get(userMessageId);
    if (!turnId) {
      turnId = newId();
      turnIds.set(userMessageId, turnId);
    }
    return turnId;
  };
}
