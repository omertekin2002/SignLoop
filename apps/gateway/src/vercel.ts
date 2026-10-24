// Vercel Function entry: Node.js runtime, Web-standard `fetch` export. scripts/build-vercel.ts
// bundles this file into the Build Output API (.vercel/output). src/dev-server.ts serves the same
// handler locally.
//
// Configuration is read once per instance, when the module loads.
import { createVercelHandler } from "./vercel-handler";

export default createVercelHandler();
