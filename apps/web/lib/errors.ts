// Typed domain errors thrown by the data layer (lib/server-db.ts). Routes map these to HTTP
// responses with `instanceof` checks instead of fragile error-message string matching. Kept in a
// dependency-free module so the data layer doesn't transitively import next/server.

export class ProjectNotFoundError extends Error {
  constructor(message = "Project not found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export class ChatThreadNotFoundError extends Error {
  constructor(message = "Chat thread not found") {
    super(message);
    this.name = "ChatThreadNotFoundError";
  }
}

export class ContractRevisionChangedError extends Error {
  constructor(message = "Contract changed while analysis was running") {
    super(message);
    this.name = "ContractRevisionChangedError";
  }
}
