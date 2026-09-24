/** Invalidates async completions when their view changes or a newer operation starts. */
export function createOperationGuard() {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    begin() {
      const operationRevision = ++revision;
      return () => revision === operationRevision;
    },
  };
}
